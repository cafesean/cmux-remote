/* cmux-remote — the inbox (p9, S-008).
 *
 * One place where sessions that are WAITING get answered. A tab beside Files / Git / Radar, wired
 * the way Radar is: self-contained (own DOM, own CSS), mounted defensively by app.js, and reachable
 * from nothing else. If this file 404s or throws on create(), the chip is removed and the terminal
 * mirror never knows.
 *
 * Dual-export, the menuparse.js discipline: the browser gets `window.cmuxInbox`, `node --test` gets
 * `module.exports`. EVERYTHING WITH LOGIC IS A PURE FUNCTION exported below — age, row truncation,
 * markers, and the read-only copy vocabulary are all decided with no DOM in sight, and the DOM layer
 * only renders what they return. That is what makes the copy table testable offline.
 *
 * Three properties this file must not break:
 *
 *   1. `question` is model-authored text out of a transcript. It NEVER reaches an HTML sink. There
 *      is no innerHTML, no insertAdjacentHTML, no outerHTML anywhere in this file — every string
 *      lands through `textContent`, so metacharacters are text by construction rather than by an
 *      escaping function someone can forget to call.
 *   2. TRUNCATION IS A RENDERING CONCERN (spec §5.6, trap 12). The row shows the first ~200
 *      characters; the card shows the whole thing, scrollable. The data is never shortened.
 *   3. The reply field is mounted IDEMPOTENTLY and rebuilt only when the surface changes.
 *      `appendChild` MOVES a node, and a move drops focus — that was the p7 regression (trap 10).
 *
 * And one absence, on purpose: THERE IS NO DISMISS. A row that is not answerable renders a sentence
 * saying why and offers no action at all (spec §5.6, principle 3).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cmuxInbox = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  // ---- copy (spec §5.6) --------------------------------------------------------------------------
  // Every sentence the operator can read is a constant here, byte-for-byte from the spec table, so a
  // test asserts the literal rather than a paraphrase. The em dashes are U+2014 and are load-bearing.

  const EMPTY_TEXT = 'Nothing waiting.';
  const PERMISSION_COPY = 'This session is waiting at a permission prompt — open the tab to answer it.';
  const HEURISTIC_COPY = 'The tab was matched by folder, not identity — open it directly to answer.';
  const FALLBACK_COPY = "This session can't be answered from here.";
  const AMBIGUOUS_COPY = "More than one terminal matches; the tab can't be identified.";
  const NO_TERMINAL_COPY = 'No terminal could be matched to this session.';
  const DEGRADED_COPY = 'Some sessions could not be classified.';

  const UNCLASSIFIED_LABEL = 'unclassified';
  const INFERRED_LABEL = 'inferred';

  // A blocked session waiting at a permission prompt is waiting on a MENU, not on text (trap 20), so
  // it is read-only even when its tab is alive and recorded. An allowlist, never a pattern.
  const PERMISSION_TYPES = ['permission_prompt', 'permission_request'];

  // `ambiguous-tabs:<count>` is a VALUE FAMILY, not a literal — the producer emits
  // `ambiguous-tabs:${count}`, so every concrete count (`:2`, `:4`, `:17`) has to reach the ambiguity
  // sentence. Matching the placeholder string `ambiguous-tabs:<n>` would send all of them to the
  // generic fallback and quietly tell the operator nothing.
  const AMBIGUOUS_TABS_RE = /^ambiguous-tabs:\d+$/;

  // Null-prototype on purpose: a `surfaceReason` of `constructor` or `toString` must miss this map
  // and fall through to the fallback, not inherit something off Object.prototype.
  const SURFACE_REASON_COPY = Object.assign(Object.create(null), {
    'recorded-tab-gone': "This session's tab is closed.",
    'shared-cwd': "Several sessions share this folder, so the tab can't be identified.",
    'ambiguous-workspace': AMBIGUOUS_COPY,
    'no-workspace-for-cwd': NO_TERMINAL_COPY,
    'no-cwd': NO_TERMINAL_COPY,
    'no-terminal-tab': NO_TERMINAL_COPY,
    'no-tab-uuid': NO_TERMINAL_COPY,
    'tree-unavailable': "The machine isn't reachable right now.",
  });

  const ROW_QUESTION_MAX = 200;

  // ---- pure layer --------------------------------------------------------------------------------

  // The canonical client identity of a row (spec §5.3): a STRING built from the two key fields, so
  // rows compare by value across separately-parsed payloads. Object identity is never the key.
  function rowKey(row) {
    const k = (row && row.sessionKey) || {};
    return JSON.stringify([k.machine == null ? null : k.machine, k.sessionId == null ? null : k.sessionId]);
  }

  function isPermissionType(notificationType) {
    return PERMISSION_TYPES.indexOf(String(notificationType == null ? '' : notificationType)) !== -1;
  }

  // The surface identity a mounted reply field belongs to. `null` is a VALUE here, not an absence:
  // a row losing its tab is a surface CHANGE, and the field has to be rebuilt for the next one.
  function surfaceSignature(row) {
    const s = row && row.surface;
    if (!s) return JSON.stringify([null, null]);
    return JSON.stringify([s.tabUuid == null ? null : s.tabUuid, s.via == null ? null : s.via]);
  }

  // Why a row cannot be answered from here — the whole vocabulary, because only ONE of these values
  // means the tab is closed and an operator told the wrong sentence goes looking in the wrong place.
  // Precedence is fixed: notificationType, then the heuristic join, then the surfaceReason table.
  function readOnlyCopy(row) {
    const r = row || {};
    if (isPermissionType(r.notificationType)) return PERMISSION_COPY;
    if (r.surface && r.surface.via === 'cwd') return HEURISTIC_COPY;
    const reason = typeof r.surfaceReason === 'string' ? r.surfaceReason : '';
    if (AMBIGUOUS_TABS_RE.test(reason)) return AMBIGUOUS_COPY;
    const hit = SURFACE_REASON_COPY[reason];
    return typeof hit === 'string' ? hit : FALLBACK_COPY;
  }

  // `unknown` rows are SHOWN, marked unclassified — never hidden, because a classifier that could not
  // reach its model must not silently swallow work that is genuinely waiting. `needs-decision` is an
  // inference and says so; it is never presented as measured.
  function rowMarkers(row) {
    const verdict = (row && row.intent && row.intent.verdict) || 'unknown';
    return {
      verdict: verdict,
      unclassified: verdict === 'unknown',
      inferred: verdict === 'needs-decision',
      label: verdict === 'unknown' ? UNCLASSIFIED_LABEL : (verdict === 'needs-decision' ? INFERRED_LABEL : ''),
    };
  }

  function relativeAge(isoString, now) {
    const t = Date.parse(isoString);
    if (!isFinite(t)) return '';
    const s = Math.max(0, (Number(now) - t) / 1000);
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  // The ROW preview, and the only place `question` is ever shortened. Collapsed to one line because a
  // row is one line; the card renders the untouched original.
  function rowQuestion(text, max) {
    const s = typeof text === 'string' ? text : '';
    const limit = typeof max === 'number' && max > 0 ? max : ROW_QUESTION_MAX;
    const one = s.replace(/\s+/g, ' ').trim();
    if (one.length <= limit) return one;
    const cut = one.slice(0, limit);
    const onWord = cut.replace(/\s+\S*$/, '');
    return (onWord || cut) + '…';
  }

  // Where the row came from, when it is known at all. repo and epic are both nullable.
  function rowWhere(row) {
    const r = row || {};
    const bits = [];
    if (r.repo) bits.push(String(r.repo));
    if (r.epic) bits.push(String(r.epic));
    return bits.join(' · ');
  }

  // ---- DOM layer ---------------------------------------------------------------------------------

  const CSS = [
    '#inbox{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;overflow:hidden;background:var(--bg)}',
    'body.mode-inbox #inbox{display:flex}',
    'body.mode-inbox footer{display:none}',
    '#inbox .ihead{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 11px;',
    '  border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}',
    '#inbox .iback{background:none;border:none;color:var(--dim);font:inherit;font-size:18px;padding:0 4px}',
    '#inbox .ititle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#inbox .inote{flex:0 0 auto;padding:9px 11px;color:var(--faint);font-size:12px}',
    '#inbox .inote a{color:var(--accent)}',
    '#inbox .ilist{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '#inbox .iempty{padding:16px 11px;color:var(--faint);font-size:13px}',
    '#inbox .irow{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--line);',
    '  color:var(--fg);font:inherit;padding:11px}',
    '#inbox .imeta{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:11px;color:var(--faint);margin-bottom:5px}',
    '#inbox .iage{color:var(--dim);font-family:var(--mono)}',
    '#inbox .imark{border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--dim);font-size:10.5px}',
    '#inbox .iq{font-size:13px;line-height:1.45;color:var(--fg);overflow-wrap:anywhere}',
    // The card. The question pane scrolls and is NEVER clamped — no line-clamp, no text-overflow:
    // the whole question has to be reachable, which is the entire reason the card exists.
    '#inbox .icard{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}',
    '#inbox .iquestion{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;',
    '  padding:12px 11px;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}',
    '#inbox .ifoot{flex:0 0 auto;border-top:1px solid var(--line);background:var(--panel)}',
    '#inbox .ireadonly{padding:12px 11px;color:var(--dim);font-size:12.5px;line-height:1.45}',
    '#inbox .ifield{display:flex;flex-direction:column;gap:8px;padding:10px 11px}',
    '#inbox .ifield textarea{width:100%;box-sizing:border-box;min-height:74px;background:var(--panel2);color:var(--fg);',
    '  border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:16px;font-family:var(--mono)}',
    '#inbox .ifield textarea:focus{outline:none;border-color:var(--accent)}',
    '#inbox .isend{align-self:flex-end;background:var(--accent);color:#0b0e14;border:none;border-radius:9px;',
    '  padding:9px 18px;font:inherit;font-weight:600}',
    '#inbox .isend[disabled]{opacity:.45}',
  ].join('\n');

  function create(opts) {
    const o = opts || {};
    const mount = o.mount;
    const jget = o.jget;
    const jpost = o.jpost;
    const promptToken = o.promptToken;
    // `onJump` is part of the factory contract (§5.6) and is accepted so the shape matches
    // cmuxRadar's. The inbox renders NO jump action in v1 — a read-only card offers no action at
    // all — so it is held, not wired.
    const onJump = o.onJump;
    const now = o.now || function () { return Date.now(); };
    if (!mount || !jget || !jpost) throw new Error('cmuxInbox.create needs mount, jget, jpost');

    const doc = mount.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('cmuxInbox.create needs a document');

    const mk = function (tag, cls, text) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    if (!doc.getElementById('inbox-style')) {
      const st = mk('style');
      st.id = 'inbox-style';
      st.textContent = CSS;
      doc.head.appendChild(st);
    }

    const pane = mk('div');
    pane.id = 'inbox';
    const head = mk('div', 'ihead');
    const backBtn = mk('button', 'iback', '‹');
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.hidden = true;
    const title = mk('span', 'ititle', 'Inbox');
    head.append(backBtn, title);

    const note = mk('div', 'inote');
    note.hidden = true;

    const list = mk('div', 'ilist');

    const cardEl = mk('div', 'icard');
    cardEl.hidden = true;
    const questionEl = mk('div', 'iquestion');
    const footEl = mk('div', 'ifoot');
    // Two fixed children, created ONCE. The read-only sentence and the reply field never share a
    // container, so clearing one can never move or destroy the other — which is what keeps the field
    // mount idempotent (trap 10).
    const readonlyEl = mk('div', 'ireadonly');
    readonlyEl.hidden = true;
    const fieldEl = mk('div', 'ifield');
    fieldEl.hidden = true;
    footEl.append(readonlyEl, fieldEl);
    cardEl.append(questionEl, footEl);

    pane.append(head, note, list, cardEl);
    mount.appendChild(pane);

    // ---- state held by the tab
    let opened = false;
    let snapshot = null;            // the last SUCCESSFULLY fetched payload
    let inflight = false;
    // The open card. `draft` survives a field unmount (answerability loss) and is restored verbatim
    // when the field comes back. `surfaceSig` is what decides whether the field is rebuilt at all.
    const card = { key: null, row: null, draft: '', input: null, sendBtn: null, surfaceSig: null };

    function setNote(text, withToken) {
      note.replaceChildren();
      if (!text) { note.hidden = true; return; }
      note.hidden = false;
      note.appendChild(doc.createTextNode(text));
      if (withToken && typeof promptToken === 'function') {
        const a = mk('a', null, ' Enter access token →');
        a.href = '#';
        a.onclick = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); promptToken(); };
        note.appendChild(a);
      }
    }

    // ---- list ------------------------------------------------------------------------------------

    function renderList() {
      list.replaceChildren();
      if (!snapshot) return;                       // nothing fetched yet — not the same as "empty"
      const items = (snapshot && snapshot.items) || [];
      if (!items.length) {
        // No zero, no badge, no count — one sentence.
        list.appendChild(mk('div', 'iempty', EMPTY_TEXT));
        return;
      }
      const t = now();
      // Server order is the contract (`blockedSince` ascending, §5.4) — oldest first. The client
      // does not re-sort; a second opinion here would only ever disagree with the snapshot.
      for (const row of items) {
        const btn = mk('button', 'irow');
        btn.type = 'button';
        btn.dataset.key = rowKey(row);
        const meta = mk('div', 'imeta');
        const age = relativeAge(row && row.blockedSince, t);
        if (age) meta.appendChild(mk('span', 'iage', age));
        const where = rowWhere(row);
        if (where) meta.appendChild(mk('span', 'iwhere', where));
        const marks = rowMarkers(row);
        if (marks.label) meta.appendChild(mk('span', 'imark', marks.label));
        btn.appendChild(meta);
        btn.appendChild(mk('div', 'iq', rowQuestion(row && row.question)));
        btn.onclick = function () { openCard(row); };
        list.appendChild(btn);
      }
    }

    // ---- card ------------------------------------------------------------------------------------

    function buildField() {
      const ta = doc.createElement('textarea');
      ta.rows = 3;
      ta.setAttribute('aria-label', 'Reply');
      ta.placeholder = 'Reply…';
      ta.value = card.draft;
      ta.oninput = function () { card.draft = ta.value; syncSend(); };
      const send = mk('button', 'isend', 'Send');
      send.type = 'button';
      send.onclick = function () { submitReply(); };
      fieldEl.replaceChildren(ta, send);
      card.input = ta;
      card.sendBtn = send;
      syncSend();
    }

    function syncSend() {
      if (!card.sendBtn) return;
      const answerable = !!(card.row && card.row.answerable);
      const typed = !!(card.input && card.input.value.trim());
      card.sendBtn.disabled = !(answerable && typed);
    }

    // The whole of trap 10 lives in this function. A card re-render for the SAME surface must leave
    // the existing textarea node exactly where it is: re-appending it would move it, and a move drops
    // focus mid-word. The field is rebuilt only when the surface signature changes, and on a rebuild
    // the retained draft is restored verbatim.
    function mountReply(row) {
      if (!row || !row.answerable) {
        // Answerability loss: keep the draft, drop the field. A read-only card has no field.
        if (card.input) card.draft = card.input.value;
        card.input = null;
        card.sendBtn = null;
        card.surfaceSig = null;
        fieldEl.replaceChildren();
        fieldEl.hidden = true;
        readonlyEl.textContent = readOnlyCopy(row);
        readonlyEl.hidden = false;
        return;
      }
      readonlyEl.replaceChildren();
      readonlyEl.hidden = true;
      fieldEl.hidden = false;
      const sig = surfaceSignature(row);
      if (card.input && card.surfaceSig === sig && card.input.parentNode === fieldEl) {
        syncSend();
        return;                                    // same surface, same node, untouched — no move
      }
      if (card.input) card.draft = card.input.value;
      card.surfaceSig = sig;
      buildField();
    }

    // Header marks are rebuilt on every render, so they are stripped first — otherwise a re-render
    // stacks a second "unclassified" chip beside the first.
    function clearHeadMarks() {
      for (const n of Array.prototype.slice.call(head.childNodes)) {
        if (n !== backBtn && n !== title) head.removeChild(n);
      }
    }

    function renderCard() {
      const row = card.row;
      if (!row) return;
      const where = rowWhere(row);
      const marks = rowMarkers(row);
      title.textContent = where || ((row.sessionKey && row.sessionKey.machine) || 'Waiting');
      // The FULL question, untouched. textContent, so metacharacters are text.
      questionEl.textContent = (row && typeof row.question === 'string') ? row.question : '';
      clearHeadMarks();
      if (marks.label) head.appendChild(mk('span', 'imark', marks.label));
      mountReply(row);
    }

    function openCard(row) {
      const key = rowKey(row);
      if (key !== card.key) { card.draft = ''; card.surfaceSig = null; card.input = null; card.sendBtn = null; fieldEl.replaceChildren(); }
      card.key = key;
      card.row = row;
      backBtn.hidden = false;
      list.hidden = true;
      cardEl.hidden = false;
      renderCard();
      // Only on OPEN, never on a re-render: a refresh landing while the operator is halfway down a
      // long question must not yank them back to the top.
      questionEl.scrollTop = 0;
    }

    // The seam a refresh re-renders an open card through. STORY-009's reconciliation calls this with
    // the freshly fetched row for the same key; this story only exercises it directly. Returns false
    // when no card is open, so a caller never has to look at internal state to find out.
    function applyOpenCard(row) {
      if (!card.key) return false;
      card.row = row;
      renderCard();
      return true;
    }

    function closeCard() {
      card.key = null;
      card.row = null;
      card.draft = '';
      card.input = null;
      card.sendBtn = null;
      card.surfaceSig = null;
      fieldEl.replaceChildren();
      fieldEl.hidden = true;
      readonlyEl.replaceChildren();
      readonlyEl.hidden = true;
      clearHeadMarks();
      backBtn.hidden = true;
      title.textContent = 'Inbox';
      cardEl.hidden = true;
      list.hidden = false;
    }

    backBtn.onclick = function () { closeCard(); };

    // The reply POST (§5.5). The SUCCESS path is here: the field clears, the card closes, and the row
    // stays until a refresh removes it — never optimistically hidden.
    //
    // SEAM: every non-success outcome deliberately does nothing here except LEAVE THE TYPED TEXT
    // WHERE IT IS. The inline sentence (`copyForCode`, the §6.1 map) and the `question_changed`
    // re-confirm machine are STORY-009's, and are not guessed at here.
    async function submitReply() {
      const row = card.row;
      if (!row || !row.answerable || !card.input) return;
      const text = card.input.value;
      if (!text.trim()) return;
      const key = (row && row.sessionKey) || {};
      let r = null;
      try {
        r = await jpost('/api/radar/inbox/reply', {
          machine: key.machine, sessionId: key.sessionId, text: text, turn: row.turn,
        });
      } catch (_) { return; }
      if (!r || !r.ok) return;
      card.draft = '';
      if (card.input) card.input.value = '';
      closeCard();
    }

    // ---- fetch -----------------------------------------------------------------------------------
    //
    // Fetch on open. The refresh PREDICATE (active tab + visible, the 60-second cadence, the single
    // timer) is STORY-009's reducer and is not improvised here — this story never fetches on a timer,
    // so it can never fetch while the tab is hidden.
    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        let r = null;
        try { r = await jget('/api/radar/inbox'); }
        catch (_) { setNote('Could not reach the server.'); return; }
        if (r.status === 401) { setNote('Not authorised.', true); return; }
        if (r.status === 503) { setNote('No snapshot yet.'); return; }
        let data = null;
        try { data = await r.json(); } catch (_) { data = null; }
        if (!r.ok || !data || !Array.isArray(data.items)) { setNote('Could not load the inbox.'); return; }
        snapshot = data;
        const degraded = !!(data.sources && data.sources.classifier === 'degraded');
        // One GLOBAL line, not a per-row warning.
        setNote(degraded ? DEGRADED_COPY : '');
        renderList();
      } finally { inflight = false; }
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    function open() {
      if (opened) return;
      opened = true;
      doc.body.classList.add('mode-inbox');
      renderList();
      load();
    }

    function close() {
      opened = false;
      doc.body.classList.remove('mode-inbox');
      closeCard();
    }

    const instance = {
      open: open,
      close: close,
      isOpen: function () { return opened; },
      // The same call `open` makes. Reachable so a browser test can force a refresh.
      refresh: load,
      openCard: openCard,
      closeCard: closeCard,
      applyOpenCard: applyOpenCard,
      el: pane,
      _card: card,
      _onJump: onJump,
    };
    return instance;
  }

  return {
    create: create,
    // pure layer — require()-able under `node --test`, no DOM
    rowKey: rowKey,
    isPermissionType: isPermissionType,
    surfaceSignature: surfaceSignature,
    readOnlyCopy: readOnlyCopy,
    rowMarkers: rowMarkers,
    relativeAge: relativeAge,
    rowQuestion: rowQuestion,
    rowWhere: rowWhere,
    // constants the tests and the copy table are pinned to
    EMPTY_TEXT: EMPTY_TEXT,
    PERMISSION_COPY: PERMISSION_COPY,
    HEURISTIC_COPY: HEURISTIC_COPY,
    FALLBACK_COPY: FALLBACK_COPY,
    AMBIGUOUS_COPY: AMBIGUOUS_COPY,
    NO_TERMINAL_COPY: NO_TERMINAL_COPY,
    DEGRADED_COPY: DEGRADED_COPY,
    UNCLASSIFIED_LABEL: UNCLASSIFIED_LABEL,
    INFERRED_LABEL: INFERRED_LABEL,
    PERMISSION_TYPES: PERMISSION_TYPES,
    AMBIGUOUS_TABS_RE: AMBIGUOUS_TABS_RE,
    SURFACE_REASON_COPY: SURFACE_REASON_COPY,
    ROW_QUESTION_MAX: ROW_QUESTION_MAX,
  };
});
