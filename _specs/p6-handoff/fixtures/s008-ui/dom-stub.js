'use strict';
// p6 S-008/S-009 evidence — the DOM stand-in that runs the REAL public/radar.js headlessly.
//
// The repo is dependency-free (no jsdom), so this implements exactly the DOM surface radar.js
// consumes and nothing more. It is the same idiom test/radar-p6-ui.test.js uses; here the tab's
// jget/jpost are REAL fetches against the harness server, so what the proofs drive is the shipped
// UI talking to the shipped routes over the shipped auth — only the browser is a stand-in.
//
// s009-suppression requires this file by relative path; both fixture dirs are owned together.
const path = require('path');

function makeText(s) {
  return { _text: s, parentNode: null, childNodes: [], get textContent() { return this._text; } };
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    _text: null,
    append(...kids) { for (const k of kids) this.appendChild(k); },
    appendChild(k) {
      if (k.parentNode) k.parentNode.removeChild(k);
      k.parentNode = this;
      this.childNodes.push(k);
      return k;
    },
    insertBefore(k, ref) {
      if (!ref) return this.appendChild(k);
      if (k.parentNode) k.parentNode.removeChild(k);
      const i = this.childNodes.indexOf(ref);
      k.parentNode = this;
      this.childNodes.splice(i === -1 ? this.childNodes.length : i, 0, k);
      return k;
    },
    removeChild(k) {
      const i = this.childNodes.indexOf(k);
      if (i !== -1) { this.childNodes.splice(i, 1); k.parentNode = null; }
      return k;
    },
    get firstChild() { return this.childNodes[0] || null; },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === this) return true;
      return false;
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return null; },
    focus() {},
    get textContent() {
      if (this._text !== null) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      this.childNodes.length = 0;
      const t = makeText(String(v));
      t.parentNode = this;
      this.childNodes.push(t);
    },
  };
  node.classList = { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } };
  let cls = '';
  Object.defineProperty(node, 'className', { get() { return cls; }, set(v) { cls = v; } });
  Object.defineProperty(node, 'offsetWidth', { get() { return 0; } });
  Object.defineProperty(node, 'offsetHeight', { get() { return 0; } });
  return node;
}

let installed = false;
function installDom() {
  if (installed) return;
  installed = true;
  const byId = {};
  global.document = {
    head: makeNode('head'),
    body: makeNode('body'),
    hidden: false,
    createElement: (tag) => {
      const n = makeNode(tag);
      Object.defineProperty(n, 'id', {
        get() { return n.attributes.id || ''; },
        set(v) { n.attributes.id = v; byId[v] = n; },
      });
      return n;
    },
    createTextNode: (s) => makeText(s),
    getElementById: (id) => byId[id] || null,
    addEventListener: () => {},
  };
  global.window = { innerWidth: 1024, innerHeight: 768, console };
  global.localStorage = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } };
}

// ---- assertion helpers: roles and text, never implementation class names ------------------------
function walk(root, fn) {
  fn(root);
  for (const c of root.childNodes || []) if (c.tagName) walk(c, fn);
}
function buttonsNamed(root, name) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'BUTTON' && n.textContent === name) out.push(n); });
  return out;
}
function allButtons(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'BUTTON') out.push(n); });
  return out;
}
function checkboxes(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'INPUT' && n.type === 'checkbox') out.push(n); });
  return out;
}
function textareas(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'TEXTAREA') out.push(n); });
  return out;
}
function containsText(root, s) {
  let hit = false;
  walk(root, (n) => { if (n._text === null && n.childNodes.some((c) => c._text !== null && c._text.indexOf(s) !== -1)) hit = true; });
  return hit;
}
function click(btn, ev) {
  if (!btn) throw new Error('click: the control does not exist');
  if (btn.disabled) throw new Error('click: the control is disabled');
  return btn.onclick(ev || { shiftKey: false });
}
const flush = () => new Promise((r) => setTimeout(r, 25));

// The recovery element, found by its OWN sentence (the node whose first child is the span holding
// the text), so an ancestor whose recursive textContent merely contains it never double-counts.
const RECOVERY_RE = /^A handoff was dispatched .+ ago and never produced a transcript, but its process is still running\.$/;
function recoveryEls(mount) {
  const out = [];
  walk(mount, (n) => {
    const first = n.childNodes[0];
    if (first && first.tagName === 'SPAN' && first.childNodes.length === 1
      && first.childNodes[0]._text !== null && RECOVERY_RE.test(first.childNodes[0]._text)) out.push(n);
  });
  return out;
}

// ---- boot the real tab ---------------------------------------------------------------------------
// `net` may be:
//   { base, token }                — REAL fetches against the harness server (the default), or
//   { state }                      — a pinned snapshot served to jget; jpost still needs base/token.
// `posts` records every outgoing mutation body, which is what most oracles assert against.
function bootRadar(net) {
  installDom();
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  require(path.join(REPO, 'public', 'radar.js'));
  const cmuxRadar = global.window.cmuxRadar;
  if (!cmuxRadar || typeof cmuxRadar.create !== 'function') throw new Error('public/radar.js did not register window.cmuxRadar');
  global.localStorage._m = {};
  const mount = makeNode('div');
  const posts = [];
  const headers = { authorization: `Bearer ${net.token}`, 'content-type': 'application/json' };
  const api = cmuxRadar.create({
    mount,
    now: net.now || (() => Date.now()),
    jget: net.state !== undefined
      ? async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(net.state)) })
      : async (p) => fetch(net.base + p, { headers: { authorization: `Bearer ${net.token}` } }),
    jpost: async (p, body) => {
      posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) });
      return fetch(net.base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    },
  });
  return { api, mount, posts };
}

module.exports = {
  makeNode, installDom, walk, buttonsNamed, allButtons, checkboxes, textareas,
  containsText, click, flush, recoveryEls, bootRadar,
};
