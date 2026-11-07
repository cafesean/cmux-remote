'use strict';
// p41 D152 — a session's task file, read-only view + a "## From Sean" list the user can add to / tick.
//
// Opt-in: HYPERMUX_TASKS_DIR (absolute path). Unset / relative = disabled (every route answers 404
// { error: 'disabled' }), so nothing outside that directory is ever read or written. One file per
// session: <dir>/<name>.md, name ^[a-z0-9-]+$ and resolving (realpath) inside the dir.
//
// File shape: YAML frontmatter (status, task_goal, done_means, asks: [{id, what, options}]) between
// `---` lines, a body, report lines `status: <WORD> <date> ... — <text>` (workers append them at the
// end), and an optional `## From Sean` section of `- [ ] <text> (added <ISO>)` items. The section is
// inserted BEFORE `## Reports`, so a worker's `>>` append still lands in Reports.
//
// Nothing here logs file content. Writes are tmp + rename in the same dir (a dotfile, Obsidian
// ignores it); a worker append between our read and rename would be lost — the window is one
// read/write of a small file.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LIMITS = {
  fileMaxBytes: 1024 * 1024,   // task file read cap; bigger -> 413 too_large
  textMax: 500,                // one From Sean item, chars
  itemsMax: 200,               // From Sean items per file; more -> 409 too_many
  reportsShown: 8,             // last N report lines returned
  bodyMax: 4096,               // POST/PATCH JSON body cap (bridge + server)
  nameMax: 128,
};
const NAME_RE = /^[a-z0-9-]+$/;
const ITEM_RE = /^- \[( |x|X)\] (.*?)(?: \(added ([^()]*)\))?\s*$/;
const SECTION = '## From Sean';

function tasksDir(env = process.env) {
  const d = env.HYPERMUX_TASKS_DIR;
  return d && path.isAbsolute(d) ? path.resolve(d) : null;
}

const unq = (v) => {
  const s = String(v).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};
const splitOptions = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s+[|/]\s+/)).map((x) => String(x).trim()).filter(Boolean);

/** Minimal frontmatter reader: top-level `key: value` + the `asks:` list (`  - id:` / `    key: value`). */
function parseFrontmatter(lines) {
  const fm = {};
  const asks = [];
  let inAsks = false;
  let cur = null;
  let curKey = null;
  for (const line of lines) {
    let m;
    if ((m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line))) {
      inAsks = m[1] === 'asks';
      cur = null;
      if (!inAsks) fm[m[1]] = unq(m[2]);
      continue;
    }
    if (!inAsks) continue;
    if ((m = /^\s*-\s+([A-Za-z_][\w-]*):\s?(.*)$/.exec(line))) {
      cur = {}; asks.push(cur); cur[m[1]] = unq(m[2]); curKey = m[1];
    } else if (cur && (m = /^\s+([A-Za-z_][\w-]*):\s?(.*)$/.exec(line))) {
      curKey = m[1];
      cur[m[1]] = m[2].trim() === '' ? [] : unq(m[2]);
    } else if (cur && curKey && Array.isArray(cur[curKey]) && (m = /^\s+-\s+(.*)$/.exec(line))) {
      cur[curKey].push(unq(m[1]));
    }
  }
  return { fm, asks };
}

const itemId = (text, added) => crypto.createHash('sha1').update(`${text}\u0000${added || ''}`).digest('hex').slice(0, 10);

function split(raw) {
  const lines = raw.split('\n');
  let end = -1;
  if (lines[0] === '---') for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  return { lines, fmLines: end > 0 ? lines.slice(1, end) : [], bodyStart: end > 0 ? end + 1 : 0 };
}

/** Section bounds [start, end) of `## From Sean` (start = heading line), or null. */
function sectionOf(lines, bodyStart) {
  const s = lines.findIndex((l, i) => i >= bodyStart && l.trim() === SECTION);
  if (s < 0) return null;
  let e = s + 1;
  while (e < lines.length && !/^#{1,2} /.test(lines[e])) e++;
  return { start: s, end: e };
}

function itemsOf(lines, sec) {
  const out = [];
  if (!sec) return out;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = ITEM_RE.exec(lines[i]);
    if (m) out.push({ id: itemId(m[2], m[3]), text: m[2], done: m[1] !== ' ', added: m[3] || null, line: i });
  }
  return out;
}

function parseTask(raw) {
  const { lines, fmLines, bodyStart } = split(raw);
  const { fm, asks } = parseFrontmatter(fmLines);
  const reports = [];
  for (let i = bodyStart; i < lines.length; i++) if (/^status: \S/.test(lines[i])) reports.push(lines[i].slice('status: '.length).trim());
  const last = reports[reports.length - 1] || '';
  const word = last.split(/\s+/)[0] || null;
  const dash = last.indexOf(' — ');
  const status = word ? { word, text: dash >= 0 ? last.slice(dash + 3).trim() : last.slice(word.length).trim() } : (fm.status ? { word: String(fm.status), text: '' } : null);
  return {
    goal: fm.task_goal || null,
    doneMeans: fm.done_means || null,
    status,
    asks: asks.filter((a) => a && a.id).map((a) => ({ id: String(a.id), what: String(a.what || ''), options: splitOptions(a.options) })),
    reports: reports.slice(-LIMITS.reportsShown),
    fromSean: itemsOf(lines, sectionOf(lines, bodyStart)).map(({ id, text, done, added }) => ({ id, text, done, added })),
  };
}

/** Normalise one item's text: one line, no control chars, trimmed. '' = invalid. */
const cleanText = (t) => (typeof t === 'string' ? t.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim() : '');

function createTasks({ dir = tasksDir(), now = () => new Date() } = {}) {
  const r = (code, body) => ({ code, body });
  const locks = new Map();   // name -> promise chain (one writer per file in this process)

  async function resolveFile(name) {
    if (!dir) return { err: r(404, { error: 'disabled' }) };
    if (typeof name !== 'string' || name.length > LIMITS.nameMax || !NAME_RE.test(name)) return { err: r(400, { error: 'bad_name' }) };
    let realDir;
    try { realDir = await fsp.realpath(dir); } catch (_) { return { err: r(404, { error: 'disabled' }) }; }
    const file = path.join(realDir, `${name}.md`);
    let real;
    try { real = await fsp.realpath(file); } catch (_) { return { err: r(404, { error: 'not_found' }) }; }
    if (path.dirname(real) !== realDir) return { err: r(400, { error: 'bad_name' }) };   // symlink out of the dir
    const st = await fsp.stat(real).catch(() => null);
    if (!st || !st.isFile()) return { err: r(404, { error: 'not_found' }) };
    if (st.size > LIMITS.fileMaxBytes) return { err: r(413, { error: 'too_large' }) };
    return { file: real };
  }

  async function read(name) {
    const f = await resolveFile(name);
    if (f.err) return f.err;
    const raw = await fsp.readFile(f.file, 'utf8');
    return r(200, parseTask(raw));
  }

  function locked(name, fn) {
    const prev = locks.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(name, next.catch(() => {}));
    return next;
  }

  async function writeAtomic(file, text) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const mode = (await fsp.stat(file)).mode & 0o777;
    await fsp.writeFile(tmp, text, { mode });
    try { await fsp.rename(tmp, file); } catch (e) { fsp.unlink(tmp).catch(() => {}); throw e; }
  }

  function edit(name, mutate) {
    return locked(name, async () => {
      const f = await resolveFile(name);
      if (f.err) return f.err;
      const raw = await fsp.readFile(f.file, 'utf8');
      const { lines, bodyStart } = split(raw);
      const out = mutate(lines, bodyStart);
      if (out.err) return out.err;
      const text = lines.join('\n');
      if (Buffer.byteLength(text) > LIMITS.fileMaxBytes) return r(413, { error: 'too_large' });
      await writeAtomic(f.file, text);
      return r(200, { ok: true, item: out.item, ...parseTask(text) });
    });
  }

  function add(name, rawText) {
    const text = cleanText(rawText);
    if (!text) return Promise.resolve(r(400, { error: 'bad_text' }));
    if (text.length > LIMITS.textMax) return Promise.resolve(r(413, { error: 'text_too_long' }));
    return edit(name, (lines, bodyStart) => {
      let sec = sectionOf(lines, bodyStart);
      if (itemsOf(lines, sec).length >= LIMITS.itemsMax) return { err: r(409, { error: 'too_many' }) };
      const added = now().toISOString();
      const line = `- [ ] ${text} (added ${added})`;
      if (!sec) {
        const rep = lines.findIndex((l, i) => i >= bodyStart && l.trim() === '## Reports');
        const block = [SECTION, line, ''];
        if (rep >= 0) lines.splice(rep, 0, ...block);
        else {
          while (lines.length && lines[lines.length - 1] === '') lines.pop();
          lines.push('', SECTION, line, '');
        }
      } else {
        // after the last item (or the heading), before trailing blank lines of the section
        let at = sec.end;
        while (at - 1 > sec.start && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, line);
      }
      return { item: { id: itemId(text, added), text, done: false, added } };
    });
  }

  function patch(name, { id, done, text: rawText } = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f]{10}$/.test(id)) return Promise.resolve(r(400, { error: 'bad_id' }));
    if (done !== undefined && typeof done !== 'boolean') return Promise.resolve(r(400, { error: 'bad_done' }));
    let text;
    if (rawText !== undefined) {
      text = cleanText(rawText);
      if (!text) return Promise.resolve(r(400, { error: 'bad_text' }));
      if (text.length > LIMITS.textMax) return Promise.resolve(r(413, { error: 'text_too_long' }));
    }
    if (done === undefined && text === undefined) return Promise.resolve(r(400, { error: 'nothing_to_change' }));
    return edit(name, (lines, bodyStart) => {
      const it = itemsOf(lines, sectionOf(lines, bodyStart)).find((x) => x.id === id);
      if (!it) return { err: r(404, { error: 'no_item' }) };
      const d = done === undefined ? it.done : done;
      const t = text === undefined ? it.text : text;
      lines[it.line] = `- [${d ? 'x' : ' '}] ${t}${it.added ? ` (added ${it.added})` : ''}`;
      return { item: { id: itemId(t, it.added), text: t, done: d, added: it.added } };
    });
  }

  return { enabled: !!dir, read, add, patch };
}

module.exports = { createTasks, parseTask, tasksDir, LIMITS, NAME_RE };
