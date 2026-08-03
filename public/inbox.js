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

  // ---- §6.1 reply outcomes — the authoritative table (spec §6.1) ---------------------------------
  //
  // The server's `message` and the client's copy are the SAME string, but the client renders its OWN
  // map and never trusts server text. Every sentence below is byte-for-byte from the spec table: the
  // separators are em dashes (U+2014), the one ellipsis is a single U+2026, and every apostrophe is
  // ASCII. A paraphrase here is a defect, not a style choice.
  //
  // The `200 ok` row is the ONE row of the table that carries no message — success clears the field
  // and closes the card and renders no sentence — so `copyForCode('ok')` returns null. "No copy" and
  // "the empty sentence" are different answers and the success path needs the first one.
  const REPLY_COPY = Object.assign(Object.create(null), {
    bad_json: 'Malformed request.',
    bad_request: 'Malformed request.',
    unknown_machine: 'No bridge is configured for this machine.',
    empty_reply: 'Reply is empty.',
    body_too_large: 'Reply exceeds the request size cap.',
    reply_too_large: 'Reply exceeds 8192 bytes.',
    unauthenticated_server: 'Set SERVER_TOKEN to enable replies.',
    viewer_refused: 'This install is a viewer — answer from the leader.',
    session_not_found: 'No trace of this session in the retained events.',
    already_answered: 'This session is no longer waiting.',
    question_changed: 'The question changed — waiting for the update…',
    surface_reassigned: 'Another session has taken over this tab.',
    not_text_answerable: 'This session is waiting at a permission prompt — open the tab to answer it.',
    tab_gone: "This session's tab is closed.",
    not_at_prompt: "The tab isn't at a Claude prompt right now.",
    pane_changed: 'The tab changed while sending — nothing was sent.',
    events_unavailable: "The event log isn't readable right now — nothing was sent.",
    bridge_unreachable: "The machine isn't reachable right now.",
    send_failed: 'Sending failed — nothing was typed into the tab.',
    send_unconfirmed: "The send wasn't confirmed — check the tab before retrying.",
    text_inserted_submit_failed: 'Text was placed in the tab but not submitted — finish it there.',
  });

  // Column 5 of §6.1: the outcomes that disable Send. Everything else leaves the button live, because
  // those outcomes are retryable and the operator's text is still sitting in the box.
  const REPLY_DISABLE_SEND = [
    'session_not_found', 'already_answered', 'question_changed', 'surface_reassigned',
    'not_text_answerable', 'tab_gone', 'send_unconfirmed', 'text_inserted_submit_failed',
  ];

  // The last row of §6.1 — unknown code, non-JSON body, the shared server's 401, a network-level
  // rejection. It never disables Send, and like every other failure row it keeps the typed text.
  const REPLY_FALLBACK_COPY = "Couldn't send — your reply is still here.";

  // Markers the DOM layer hands to `copyForCode` when there is no code to hand it. They are ordinary
  // strings that are deliberately absent from REPLY_COPY, so they reach the fallback by the same
  // route an unrecognised server code does — no second branch to keep in step with the first.
  const REPLY_NON_JSON = 'client:non-json';
  const REPLY_NETWORK_ERROR = 'client:network-error';
  const REPLY_UNAUTHORIZED = 'client:unauthorized';

  // ---- the `question_changed` machine (spec §5.6) ------------------------------------------------
  //
  // Three states, TWO DISJOINT ENTRIES, and no reachable path that POSTs a stale turn token.
  const MACHINE_READY = 'ready';
  const MACHINE_AWAITING_FRESH = 'awaiting-fresh';
  const MACHINE_RECONFIRM = 'reconfirm-required';

  // Copy ownership, stated once: the WAITING sentence is the server's message and `copyForCode`'s
  // entry for `question_changed`; the REVIEW sentence is state-local copy for `reconfirm-required`
  // and is never returned by the server, never by `copyForCode`.
  const QUESTION_CHANGED_REVIEW = 'The question changed — review it before sending.';

  // An open card whose key leaves the payload (§5.6). The same sentence as `already_answered`, and
  // for the same reason — but it arrives from a refresh, not from a reply.
  const VANISHED_COPY = 'This session is no longer waiting.';

  // §6.2: a failed refresh leaves the list and every draft untouched and says one line. The spec
  // pins the BEHAVIOUR here, not the words; this sentence is state-local copy and says the thing the
  // operator needs to know, which is that nothing they typed was lost.
  const REFRESH_FAILED_COPY = "Couldn't refresh — your reply is still here.";

  // The cadence, in ms (§5.6). One timer, and only while the predicate holds.
  const REFRESH_MS = 60000;

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

  // The turn identity token, as a VALUE. `foldSession` speaks numeric ms and rows speak ISO, but by
  // the time a turn reaches this file it is the row's `{blockedSince, assistantTs}` pair of ISO
  // strings — so a signature is all the comparison a turn change ever needs, and it survives being
  // parsed out of two different payloads.
  function turnSignature(turn) {
    const t = turn || {};
    return JSON.stringify([
      t.blockedSince == null ? null : t.blockedSince,
      t.assistantTs == null ? null : t.assistantTs,
    ]);
  }

  // The surface a row currently lives on. `null` is a VALUE here, not an absence: a row losing its
  // tab is a surface CHANGE, exactly like moving to a different one.
  function surfaceOf(row) {
    const s = row && row.surface;
    return s && s.tabUuid != null ? String(s.tabUuid) : null;
  }

  // Structural value equality. Rows arrive as freshly parsed JSON on every refresh, so two payloads
  // that say the same thing share no object at all — comparing by identity would call every row
  // "changed" forever, which is trap 11's shape (an enforcement that fires the event that would
  // clear it).
  function valueEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!valueEqual(a[i], b[i])) return false;
      return true;
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!valueEqual(a[k], b[k])) return false;
    }
    return true;
  }

  // ---- §6.1: code -> copy, disable rule, re-confirm rule -----------------------------------------
  //
  // `null` for the success row. `{text, disableSend, requiresReconfirm}` for every failure row, and
  // the fallback for anything this table has never heard of.
  function copyForCode(code) {
    if (code === 'ok') return null;
    const key = typeof code === 'string' ? code : '';
    const text = REPLY_COPY[key];
    if (typeof text !== 'string') {
      return { code: null, text: REPLY_FALLBACK_COPY, disableSend: false, requiresReconfirm: false };
    }
    return {
      code: key,
      text: text,
      disableSend: REPLY_DISABLE_SEND.indexOf(key) !== -1,
      requiresReconfirm: key === 'question_changed',
    };
  }

  // ---- reconciliation (spec §5.6) ----------------------------------------------------------------

  function normalizeOpenCard(openCard) {
    if (openCard == null) return null;
    if (typeof openCard === 'string') return { key: openCard, row: null, turn: undefined };
    if (openCard.key == null) return null;
    return { key: String(openCard.key), row: openCard.row || null, turn: openCard.turn };
  }

  // reconcileRows(prev, next, openCard) -> per-row decisions plus the open card's fate.
  //
  // A SURFACE-ONLY CHANGE AND A TURN CHANGE ARE DIFFERENT EVENTS. The surface decision is computed
  // here from the two rows and nothing else — it never reads the `question_changed` machine, and it
  // writes to it only through `machineEvent`, which is non-null ONLY when the turn actually differs.
  // A surface-only refresh therefore hands the machine nothing at all, which is what makes "it
  // creates no notice, and it does not clear one an existing state is showing" structurally true
  // rather than a rule somebody has to remember.
  function reconcileRows(prev, next, openCard) {
    const prevRows = Array.isArray(prev) ? prev : [];
    const nextRows = Array.isArray(next) ? next : [];
    const prevByKey = new Map();
    for (const r of prevRows) if (!prevByKey.has(rowKey(r))) prevByKey.set(rowKey(r), r);
    const nextByKey = new Map();
    const rows = [];
    for (const r of nextRows) {
      const key = rowKey(r);
      if (!nextByKey.has(key)) nextByKey.set(key, r);
      const had = prevByKey.has(key);
      rows.push({ key: key, row: r, decision: !had ? 'add' : (valueEqual(prevByKey.get(key), r) ? 'keep' : 'replace') });
    }
    const vanished = [];
    for (const r of prevRows) {
      const key = rowKey(r);
      if (!nextByKey.has(key) && vanished.indexOf(key) === -1) vanished.push(key);
    }

    const open = normalizeOpenCard(openCard);
    let card = null;
    if (open) {
      const fresh = nextByKey.has(open.key) ? nextByKey.get(open.key) : null;
      const wasRow = open.row || (prevByKey.has(open.key) ? prevByKey.get(open.key) : null);
      if (!fresh) {
        // The key left the payload. The draft is kept, the field stays where it is, Send goes dead,
        // and the card says so — never optimistically emptied, never silently reopened.
        card = {
          key: open.key, survived: false, row: null, decision: 'vanished',
          surfaceChanged: false, turnChanged: false, field: 'keep', answerable: false,
          draft: 'kept', machineEvent: null, line: VANISHED_COPY,
        };
      } else {
        const wasAnswerable = !!(wasRow && wasRow.answerable);
        const nowAnswerable = !!fresh.answerable;
        const surfaceChanged = surfaceOf(wasRow) !== surfaceOf(fresh);
        const wasTurn = open.turn === undefined ? (wasRow && wasRow.turn) : open.turn;
        const turnChanged = turnSignature(wasTurn) !== turnSignature(fresh.turn);
        // Field EXISTENCE is answerability's call and outranks the remount rule: a read-only card
        // has no field at all. Only once the field exists does the surface decide whether the node
        // survives — `appendChild` moves a node and a move drops focus (trap 10).
        let field;
        if (!nowAnswerable) field = 'unmount';
        else if (!wasAnswerable) field = 'mount';
        else if (surfaceChanged) field = 'remount';
        else field = 'keep';
        card = {
          key: open.key, survived: true, row: fresh,
          decision: turnChanged ? 'turn-changed' : (surfaceChanged ? 'surface-only' : 'unchanged'),
          surfaceChanged: surfaceChanged, turnChanged: turnChanged,
          field: field, answerable: nowAnswerable, draft: 'kept',
          machineEvent: turnChanged ? { type: 'refresh', turn: fresh.turn } : null,
          line: null,
        };
      }
    }
    return { rows: rows, vanished: vanished, openCard: card };
  }

  // ---- the three-state machine (spec §5.6) -------------------------------------------------------

  function machineInitial(turn) {
    return { name: MACHINE_READY, turn: turn === undefined ? null : turn };
  }

  // The notice is DERIVED from the state, never stored. That is what makes "the review sentence is
  // reconfirm-required state copy" true by construction: there is no other producer of it.
  function machineNotice(name) {
    if (name === MACHINE_AWAITING_FRESH) return REPLY_COPY.question_changed;
    if (name === MACHINE_RECONFIRM) return QUESTION_CHANGED_REVIEW;
    return null;
  }

  function machineReduce(state, event) {
    const s = state && state.name ? state : machineInitial(null);
    const ev = event || {};
    const stay = { state: s, immediateGet: false, post: null };

    if (ev.type === 'reply-response') {
      // ENTRY 1, and the ONLY transition in the whole machine that emits an extra GET. Guarded on
      // `ready` so a duplicated or late response can never emit a second one.
      if (ev.code === 'question_changed' && s.name === MACHINE_READY) {
        return { state: { name: MACHINE_AWAITING_FRESH, turn: s.turn }, immediateGet: true, post: null };
      }
      return stay;
    }

    if (ev.type === 'refresh') {
      const fresh = ev.turn === undefined ? null : ev.turn;
      if (turnSignature(fresh) === turnSignature(s.turn)) return stay;
      // ENTRY 2. A changed-turn refresh IS the fresh arrival, so there is nothing left to wait for:
      // straight to `reconfirm-required` with NO extra GET, from `awaiting-fresh` or from a `ready`
      // card that never POSTed at all.
      return { state: { name: MACHINE_RECONFIRM, turn: fresh }, immediateGet: false, post: null };
    }

    if (ev.type === 'confirm') {
      // A tap is only meaningful once the fresh question is on screen. In `awaiting-fresh` it is a
      // NO-OP: going ready there would arm a Send carrying the token the server already refused.
      if (s.name === MACHINE_RECONFIRM) return { state: { name: MACHINE_READY, turn: s.turn }, immediateGet: false, post: null };
      return stay;
    }

    if (ev.type === 'send') {
      if (s.name !== MACHINE_READY) return stay;   // structural no-op in both non-ready states
      return { state: s, immediateGet: false, post: { turn: s.turn } };
    }

    return stay;
  }

  // ---- the send conjunction ----------------------------------------------------------------------

  // §5.6, stated once and used everywhere: effective send is ONE conjunction.
  function sendEnabled(answerable, machine) {
    return !!answerable && machine === MACHINE_READY;
  }

  // What the button actually gets. The conjunction, plus three LATCHES — they are not axes of the
  // conjunction, they are flags set by a named event and cleared by a named event: `latched` by a
  // §6.1 disable-send code (cleared by a new turn or by closing the card), `vanished` by the key
  // leaving the payload (cleared by its return), and `sending` by a POST leaving the client (cleared
  // the moment its result lands). `sending` is NOT a fourth machine state — it never touches the
  // machine, and Send comes back through the ordinary `answerable && ready` conjunction.
  function canSend(card) {
    if (!card) return false;
    return sendEnabled(card.answerable, card.machine) && !card.latched && !card.vanished && !card.sending;
  }

  // ---- card state + the reducers the DOM layer renders -------------------------------------------

  // `gen` is the CARD GENERATION: the identity of this opening of this card. It is minted when a card
  // is opened and retired when one is closed, so a reply response that resolves after the operator
  // moved on can be recognised as belonging to a card that no longer exists. It is state, not a DOM
  // property, because the decision it drives — "drop this result whole" — is a pure-layer decision.
  // Omitting it (every caller that predates it, and every pure test) leaves it null, and a null
  // generation disables the check entirely rather than matching everything.
  function openCardState(row, gen) {
    return {
      key: rowKey(row),
      row: row || null,
      turn: (row && row.turn) || null,
      draft: '',
      machine: MACHINE_READY,
      answerable: !!(row && row.answerable),
      vanished: false,
      latched: false,
      sending: false,
      gen: gen === undefined ? null : gen,
      line: null,
    };
  }

  function normalizeState(state) {
    const s = state || {};
    return { rows: Array.isArray(s.rows) ? s.rows : [], card: s.card || null };
  }

  // The single render instruction. The DOM layer executes it and decides nothing.
  function instructionsFor(card, extra) {
    const e = extra || {};
    return {
      list: e.list || 'keep',
      field: e.field || 'none',
      draft: card ? card.draft : '',
      // THE MACHINE OUTRANKS EVERYTHING TRANSIENT. A refresh-failure line, or a leftover §6.1
      // sentence, can never displace the waiting or review notice.
      notice: card ? (machineNotice(card.machine) || card.line || null) : null,
      noticeTappable: !!(card && card.machine === MACHINE_RECONFIRM),
      readOnly: card && card.row && !card.answerable ? readOnlyCopy(card.row) : null,
      sendEnabled: canSend(card),
      immediateGet: !!e.immediateGet,
      closeCard: !!e.closeCard,
      clearField: !!e.clearField,
      post: e.post || null,
      // Who sent `post`, as a value the caller hands straight back to `applyReplyResult` when the
      // response lands. Deliberately NOT part of `post`: `post` is the wire body and gains no
      // client-only fields.
      postedCard: e.postedCard || null,
    };
  }

  // Apply one reconciliation decision to the open card. The machine is touched ONLY through
  // `decision.machineEvent`, which reconcileRows leaves null unless the turn really changed.
  function applyCardDecision(card, decision) {
    if (!card || !decision) return { card: card, immediateGet: false, field: 'none' };
    if (!decision.survived) {
      return { card: Object.assign({}, card, { vanished: true, line: decision.line }), immediateGet: false, field: decision.field };
    }
    let machine = { name: card.machine, turn: card.turn };
    let immediateGet = false;
    if (decision.machineEvent) {
      const m = machineReduce(machine, decision.machineEvent);
      machine = m.state;
      immediateGet = m.immediateGet;
    }
    const next = Object.assign({}, card, {
      row: decision.row,
      answerable: decision.answerable,
      machine: machine.name,
      turn: machine.turn,
      vanished: false,
      // A new turn is a new question: the §6.1 latch the OLD question earned does not survive it.
      latched: decision.turnChanged ? false : card.latched,
      line: decision.turnChanged ? null : card.line,
      // `draft` is not in this list, on purpose. It is never touched by a refresh.
    });
    return { card: next, immediateGet: immediateGet, field: decision.field };
  }

  // A refresh landing. `result` is `{ok: true, items}` or anything else, which is a failure.
  function applyRefresh(state, result) {
    const st = normalizeState(state);
    if (!result || result.ok !== true) {
      // §6.2: the list and every draft are untouched, and one inline line is emitted.
      const card = st.card ? Object.assign({}, st.card, { line: REFRESH_FAILED_COPY }) : null;
      return { state: { rows: st.rows, card: card }, instr: instructionsFor(card, { list: 'keep', field: 'keep' }) };
    }
    const items = Array.isArray(result.items) ? result.items : [];
    const rec = reconcileRows(st.rows, items, st.card ? { key: st.card.key, row: st.card.row, turn: st.card.turn } : null);
    const applied = applyCardDecision(st.card, rec.openCard);
    return {
      state: { rows: items, card: applied.card },
      reconciled: rec,
      instr: instructionsFor(applied.card, { list: 'replace', field: applied.field, immediateGet: applied.immediateGet }),
    };
  }

  // The same reconciliation for exactly one row — the seam a card re-render goes through when the
  // caller already knows which row it is holding.
  function applyCardRow(state, row) {
    const st = normalizeState(state);
    if (!st.card) return { state: st, instr: instructionsFor(null, {}) };
    const prevRow = st.card.row ? [st.card.row] : [];
    const rec = reconcileRows(prevRow, [row], { key: st.card.key, row: st.card.row, turn: st.card.turn });
    const applied = applyCardDecision(st.card, rec.openCard);
    const key = st.card.key;
    const rows = st.rows.map(function (r) { return rowKey(r) === key ? row : r; });
    return {
      state: { rows: rows, card: applied.card },
      reconciled: rec,
      instr: instructionsFor(applied.card, { list: 'keep', field: applied.field, immediateGet: applied.immediateGet }),
    };
  }

  function applyDraft(state, text) {
    const st = normalizeState(state);
    if (!st.card) return { state: st, instr: instructionsFor(null, {}) };
    const card = Object.assign({}, st.card, { draft: typeof text === 'string' ? text : '' });
    return { state: { rows: st.rows, card: card }, instr: instructionsFor(card, { field: 'keep' }) };
  }

  // A Send press. In `awaiting-fresh` and `reconfirm-required` this is a pure no-op — no post comes
  // back — because `canSend` is the conjunction and the conjunction requires `ready`.
  function applySend(state, text) {
    const st = normalizeState(state);
    const card = st.card ? Object.assign({}, st.card, text === undefined ? {} : { draft: typeof text === 'string' ? text : '' }) : null;
    const base = { rows: st.rows, card: card };
    if (!canSend(card) || !String(card.draft).trim()) {
      return { state: base, instr: instructionsFor(card, { field: 'keep' }) };
    }
    const m = machineReduce({ name: card.machine, turn: card.turn }, { type: 'send' });
    if (!m.post) return { state: base, instr: instructionsFor(card, { field: 'keep' }) };
    const key = (card.row && card.row.sessionKey) || {};
    // Plain text only in v1, and `turn` copied verbatim from the row the card is holding.
    const post = { machine: key.machine, sessionId: key.sessionId, text: card.draft, turn: m.post.turn };
    // The card goes IN FLIGHT: Send dies for the duration and the draft is not touched. This is the
    // second lock on the same seam — one tap cannot become two POSTs carrying the same token, and the
    // window in which a response can outlive its card is as small as the round trip allows.
    const sending = Object.assign({}, card, { sending: true });
    return {
      state: { rows: st.rows, card: sending },
      instr: instructionsFor(sending, {
        field: 'keep', post: post,
        // The sender's identity travels with the request and comes back with the response.
        postedCard: { gen: sending.gen === undefined ? null : sending.gen, turn: m.post.turn },
      }),
    };
  }

  // The reply's outcome. THE TYPED TEXT IS KEPT ON EVERY SINGLE NON-SUCCESS PATH — `draft` appears
  // in none of the branches below except the success one, which clears it deliberately.
  //
  // A REPLY RESPONSE IS ADDRESSED. `posted` is `instr.postedCard` from the `applySend` that issued
  // the request — `{gen, turn}` — and it is what makes "this result is for the card in front of me"
  // a checkable fact rather than an assumption. The server's send phase alone can take many seconds,
  // and in that window the operator can tap Back, open another row and start typing; without an
  // address the response lands on WHOEVER IS OPEN. Two independent staleness axes, because they are
  // two different mistakes:
  //
  //   1. STALE CARD (`gen` differs, or nothing is open at all) — the result belongs to a card that no
  //      longer exists. It is DROPPED WHOLE: no close, no field clear, no machine transition, no
  //      line. §6.1 promises the typed text is always retained, and applying `ok` here would destroy
  //      a draft the operator never sent.
  //   2. STALE TURN (same card, but its `turn` moved on while the POST was in flight) — the question
  //      the server answered is not the question on screen. The §6.1 latch and sentence are skipped,
  //      because "a new turn is a new question" and a latch earned by the old one must not survive
  //      onto the new one and leave Send permanently dead on a live question.
  //
  // `ok` is the one outcome a stale TURN does not suppress: the send genuinely landed in the pane, so
  // the card closes. A stale CARD suppresses even that — there is no card of that generation to close.
  // Both checks are opt-in: `posted` omitted, or a null `gen`/absent `turn`, leaves the old behaviour
  // exactly as it was.
  function applyReplyResult(state, code, posted) {
    const st = normalizeState(state);
    const card = st.card;
    const p = posted || null;
    if (p && p.gen != null && (!card || card.gen !== p.gen)) {
      return { state: st, instr: instructionsFor(card, { field: 'keep' }), dropped: true, stale: true };
    }
    if (!card) return { state: st, instr: instructionsFor(null, {}), dropped: true, stale: false };
    const copy = copyForCode(code);
    if (copy === null) {
      // §6.1's success row: the field clears, the card closes, and the ROW STAYS in the list until a
      // refresh removes it. Never optimistically hidden.
      return { state: { rows: st.rows, card: null }, instr: instructionsFor(null, { closeCard: true, clearField: true }) };
    }
    const staleTurn = !!(p && p.turn !== undefined && turnSignature(p.turn) !== turnSignature(card.turn));
    let machine = { name: card.machine, turn: card.turn };
    let immediateGet = false;
    if (copy.requiresReconfirm && !staleTurn) {
      const m = machineReduce(machine, { type: 'reply-response', code: 'question_changed' });
      machine = m.state;
      immediateGet = m.immediateGet;
    }
    const next = Object.assign({}, card, {
      machine: machine.name,
      turn: machine.turn,
      // The round trip is over either way — the button comes back through the conjunction, never by
      // a branch of its own.
      sending: false,
      // The machine owns the disable for `question_changed`; latching it as well would outlive the
      // confirm tap and leave Send dead on the fresh turn.
      latched: staleTurn ? card.latched : (copy.disableSend && !copy.requiresReconfirm ? true : card.latched),
      // ...and the notice for it, so the waiting sentence has exactly one producer.
      line: staleTurn ? card.line : (copy.requiresReconfirm ? null : copy.text),
    });
    return {
      state: { rows: st.rows, card: next },
      instr: instructionsFor(next, { field: 'keep', immediateGet: immediateGet }),
      dropped: false, stale: staleTurn,
    };
  }

  function applyConfirm(state) {
    const st = normalizeState(state);
    if (!st.card) return { state: st, instr: instructionsFor(null, {}) };
    const m = machineReduce({ name: st.card.machine, turn: st.card.turn }, { type: 'confirm' });
    const next = Object.assign({}, st.card, { machine: m.state.name, turn: m.state.turn });
    return { state: { rows: st.rows, card: next }, instr: instructionsFor(next, { field: 'keep' }) };
  }

  // ---- the refresh predicate, as a reducer (spec §5.6) -------------------------------------------
  //
  // Exactly one timer exists, and only while the Inbox tab is active AND the document is visible.
  // Modelling it as a reducer is what makes "never while it does not hold" checkable offline: there
  // is one place where `start` can be produced, and it is guarded on the predicate flipping.
  function refreshInitial(over) {
    return Object.assign({ active: false, visible: true, armed: false, timer: null }, over || {});
  }

  function refreshReduce(state, event) {
    const st = refreshInitial(state);
    const ev = event || {};
    const stay = { state: st, get: false, start: false, stop: false, stopped: null };

    if (ev.type === 'tick') {
      // A tick that lands after the predicate dropped is ignored. Clearing a timer is never quite
      // instantaneous, and a late tick must not become a load while the tab is hidden.
      return { state: st, get: st.active && st.visible, start: false, stop: false, stopped: null };
    }

    let active = st.active;
    let visible = st.visible;
    if (ev.type === 'open') active = true;
    else if (ev.type === 'close') active = false;
    else if (ev.type === 'active') active = !!ev.value;
    else if (ev.type === 'visible') visible = !!ev.value;
    else return stay;

    const was = st.active && st.visible;
    const holds = active && visible;
    if (!was && holds) {
      return { state: { active: active, visible: visible, armed: true, timer: null }, get: true, start: true, stop: false, stopped: null };
    }
    if (was && !holds) {
      return { state: { active: active, visible: visible, armed: false, timer: null }, get: false, start: false, stop: true, stopped: st.timer };
    }
    return { state: { active: active, visible: visible, armed: st.armed, timer: st.timer }, get: false, start: false, stop: false, stopped: null };
  }

  // Records the handle the caller created in response to a `start`. Kept separate so the reducer
  // itself never touches a clock.
  function refreshSetTimer(state, handle) {
    return Object.assign(refreshInitial(state), { timer: handle });
  }

  // ---- DOM layer ---------------------------------------------------------------------------------

  const CSS = [
    '#inbox{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;overflow:hidden;background:var(--bg)}',
    'body.mode-inbox #inbox{display:flex}',
    'body.mode-inbox footer{display:none}',
    // THE HIDDEN ATTRIBUTE IS NOT SELF-ENFORCING HERE. `[hidden]{display:none}` lives in the UA
    // stylesheet, so ANY author rule that sets `display` on the same element beats it — and two of
    // the rules below do exactly that (`.icard` and `.ifield` are flex columns). Without this reset
    // `cardEl.hidden = true` in closeCard() is a NO-OP: the card stays painted and the question from
    // the last card you opened sits under the list forever, next to "Nothing waiting.".
    // It shipped that way because the browser AC asserted the ATTRIBUTE (`.icard.hidden === true`,
    // which was always true) instead of the rendered box — see test/browser/inbox.browser.mjs.
    // `!important` rather than source-order precedence: the next `display` rule added to this sheet
    // must not be able to resurrect the bug.
    '#inbox [hidden]{display:none !important}',
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
    // The one inline sentence a card ever shows: a §6.1 outcome, the machine's notice, or the
    // failed-refresh line. Deliberately NOT a <button> even when it is tappable — a read-only card
    // must contain no button of any kind, and one element that is sometimes a control is a smaller
    // surface than two elements that are sometimes present.
    '#inbox .inotice{padding:10px 11px;color:var(--fg);font-size:12.5px;line-height:1.45;',
    '  border-top:1px solid var(--line);background:var(--panel2)}',
    '#inbox .inotice.itap{color:var(--accent)}',
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
    // The refresh timer is injectable so a test can drive the cadence without a clock. The default
    // unrefs where that is available (node) so a mounted inbox can never hold a test process open;
    // in a browser setInterval returns a number and the guard simply does nothing.
    const setTimer = o.setTimer || function (fn, ms) {
      const t = setInterval(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
    const clearTimer = o.clearTimer || function (t) { clearInterval(t); };
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
    const noticeEl = mk('div', 'inotice');
    noticeEl.hidden = true;
    const readonlyEl = mk('div', 'ireadonly');
    readonlyEl.hidden = true;
    const fieldEl = mk('div', 'ifield');
    fieldEl.hidden = true;
    footEl.append(noticeEl, readonlyEl, fieldEl);
    cardEl.append(questionEl, footEl);

    pane.append(head, note, list, cardEl);
    mount.appendChild(pane);

    // ---- state held by the tab
    let opened = false;
    let snapshot = null;            // the last SUCCESSFULLY fetched payload
    let inflight = false;
    // THE PURE STATE. Every decision about drafts, surfaces, turns, notices and whether Send is live
    // is made by the exported functions above and lands here; the block below only renders it.
    let pure = { rows: [], card: null };
    let refreshState = refreshInitial({ visible: visibleNow() });
    // The card generation. Monotonic, minted on open, retired on close — never reused, so a reply
    // response can always be told apart from the card it would otherwise land on.
    let cardGen = 0;
    // The two DOM handles the card owns. `card.input` is the node trap 10 is about.
    const card = { input: null, sendBtn: null };

    function visibleNow() {
      // An environment that cannot tell us counts as visible: the alternative is an inbox that never
      // loads because a stand-in document has no Page Visibility API.
      if (!doc || doc.visibilityState === undefined || doc.visibilityState === null) return true;
      return doc.visibilityState === 'visible';
    }

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

    function buildField(draft) {
      const ta = doc.createElement('textarea');
      ta.rows = 3;
      ta.setAttribute('aria-label', 'Reply');
      ta.placeholder = 'Reply…';
      ta.value = typeof draft === 'string' ? draft : '';
      ta.oninput = function () { onDraft(ta.value); };
      const send = mk('button', 'isend', 'Send');
      send.type = 'button';
      send.onclick = function () { submitReply(); };
      fieldEl.replaceChildren(ta, send);
      card.input = ta;
      card.sendBtn = send;
    }

    function onDraft(text) {
      const out = applyDraft(pure, text);
      pure = out.state;
      syncSend(out.instr);
    }

    function syncSend(instr) {
      if (!card.sendBtn) return;
      const typed = !!(card.input && card.input.value.trim());
      card.sendBtn.disabled = !(instr.sendEnabled && typed);
    }

    // The whole of trap 10 lives here. A card re-render whose instruction is `keep` must leave the
    // existing textarea node exactly where it is: re-appending it would MOVE it, and a move drops
    // focus mid-word. The pure layer decides mount/remount/unmount/keep; this executes it.
    function applyField(instr) {
      if (instr.readOnly != null || instr.field === 'unmount') {
        // Answerability loss: keep the draft (it lives in the pure state, not in the node), drop the
        // field. A read-only card has no field at all — that beats the remount rule for EXISTENCE.
        card.input = null;
        card.sendBtn = null;
        fieldEl.replaceChildren();
        fieldEl.hidden = true;
        readonlyEl.textContent = instr.readOnly == null ? '' : instr.readOnly;
        readonlyEl.hidden = false;
        return;
      }
      readonlyEl.replaceChildren();
      readonlyEl.hidden = true;
      fieldEl.hidden = false;
      if (instr.field === 'keep' && card.input && card.input.parentNode === fieldEl) {
        syncSend(instr);
        return;                                    // same surface, same node, untouched — no move
      }
      buildField(instr.draft);                     // mount or remount: the draft goes back verbatim
      syncSend(instr);
    }

    function renderNotice(instr) {
      if (!instr.notice) {
        noticeEl.replaceChildren();
        noticeEl.hidden = true;
        noticeEl.onclick = null;
        noticeEl.className = 'inotice';
        return;
      }
      noticeEl.textContent = instr.notice;
      noticeEl.hidden = false;
      noticeEl.className = instr.noticeTappable ? 'inotice itap' : 'inotice';
      noticeEl.setAttribute('role', instr.noticeTappable ? 'button' : 'status');
      noticeEl.setAttribute('tabindex', instr.noticeTappable ? '0' : '-1');
      noticeEl.onclick = instr.noticeTappable ? function () { confirmTap(); } : null;
    }

    // Header marks are rebuilt on every render, so they are stripped first — otherwise a re-render
    // stacks a second "unclassified" chip beside the first.
    function clearHeadMarks() {
      for (const n of Array.prototype.slice.call(head.childNodes)) {
        if (n !== backBtn && n !== title) head.removeChild(n);
      }
    }

    function renderCard(instr) {
      if (!pure.card) return;
      const row = pure.card.row;
      if (!row) { renderNotice(instr); syncSend(instr); return; }
      const where = rowWhere(row);
      const marks = rowMarkers(row);
      title.textContent = where || ((row.sessionKey && row.sessionKey.machine) || 'Waiting');
      // The FULL question, untouched. textContent, so metacharacters are text.
      questionEl.textContent = (row && typeof row.question === 'string') ? row.question : '';
      clearHeadMarks();
      if (marks.label) head.appendChild(mk('span', 'imark', marks.label));
      renderNotice(instr);
      applyField(instr);
    }

    function openCard(row) {
      const key = rowKey(row);
      if (!pure.card || key !== pure.card.key) {
        card.input = null;
        card.sendBtn = null;
        fieldEl.replaceChildren();
        // A NEW card, so a new generation — including a reopen of the same key, which is a different
        // opening and must not inherit an in-flight POST's answer.
        pure = { rows: pure.rows, card: openCardState(row, ++cardGen) };
      } else {
        pure = { rows: pure.rows, card: Object.assign({}, pure.card, { row: row, answerable: !!row.answerable }) };
      }
      backBtn.hidden = false;
      list.hidden = true;
      cardEl.hidden = false;
      renderCard(instructionsFor(pure.card, { field: card.input ? 'keep' : 'mount' }));
      // Only on OPEN, never on a re-render: a refresh landing while the operator is halfway down a
      // long question must not yank them back to the top.
      questionEl.scrollTop = 0;
    }

    // The seam a refresh re-renders an open card through — one row, reconciled by the pure layer
    // exactly as a whole payload would be. Returns false when no card is open, so a caller never has
    // to look at internal state to find out.
    function applyOpenCard(row) {
      if (!pure.card) return false;
      const out = applyCardRow(pure, row);
      pure = out.state;
      renderCard(out.instr);
      if (out.instr.immediateGet) load();
      return true;
    }

    // One explicit tap on the review notice -> `ready`, Send live again, carrying the FRESH turn.
    function confirmTap() {
      if (!pure.card) return;
      const out = applyConfirm(pure);
      pure = out.state;
      renderCard(out.instr);
    }

    function closeCard() {
      // Retire the generation FIRST. Anything still in flight for this card is now addressed to a
      // card that does not exist, which is exactly what `applyReplyResult` drops.
      cardGen += 1;
      pure = { rows: pure.rows, card: null };
      card.input = null;
      card.sendBtn = null;
      fieldEl.replaceChildren();
      fieldEl.hidden = true;
      readonlyEl.replaceChildren();
      readonlyEl.hidden = true;
      noticeEl.replaceChildren();
      noticeEl.hidden = true;
      noticeEl.onclick = null;
      clearHeadMarks();
      backBtn.hidden = true;
      title.textContent = 'Inbox';
      cardEl.hidden = true;
      list.hidden = false;
    }

    backBtn.onclick = function () { closeCard(); };

    // The response's §6.1 code, or one of the client-side markers that reach the same fallback. A
    // body that is not JSON, a 401 from the shared server's auth gate, and a network-level rejection
    // are all "we do not know what happened", and the operator gets one sentence and their text.
    async function replyCode(r) {
      if (!r) return REPLY_NETWORK_ERROR;
      if (r.ok) return 'ok';
      let body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      if (body && typeof body.error === 'string') return body.error;
      if (body && typeof body.code === 'string') return body.code;
      return r.status === 401 ? REPLY_UNAUTHORIZED : REPLY_NON_JSON;
    }

    // The reply POST (§5.5). Success clears the field and closes the card and leaves the ROW alone
    // until a refresh removes it. Every other outcome renders one sentence from `copyForCode` and
    // LEAVES THE TYPED TEXT WHERE IT IS.
    async function submitReply() {
      const attempt = applySend(pure, card.input ? card.input.value : undefined);
      pure = attempt.state;
      if (!attempt.instr.post) { renderCard(attempt.instr); return; }
      // Send goes dead for the round trip. Only the button — the textarea keeps focus, keeps the
      // caret and keeps the text, so this is invisible to anyone who is not double-tapping.
      syncSend(attempt.instr);
      let r = null;
      try { r = await jpost('/api/radar/inbox/reply', attempt.instr.post); } catch (_) { r = null; }
      const code = await replyCode(r);
      // The response is addressed to the card that sent it. If the operator has since tapped Back or
      // opened another row, this result belongs to nobody: it is dropped without touching the card
      // that IS open — whose draft, machine state and Send button are none of its business.
      const out = applyReplyResult(pure, code, attempt.instr.postedCard);
      if (out.dropped) return;
      pure = out.state;
      if (out.instr.clearField && card.input) card.input.value = '';
      if (out.instr.closeCard) { closeCard(); return; }
      renderCard(out.instr);
      // The one extra GET in the whole design, and it is predicate-independent: the client has no
      // fresh question until a sweep delivers one, so it asks immediately rather than waiting out
      // the cadence.
      if (out.instr.immediateGet) load();
    }

    // ---- loading ---------------------------------------------------------------------------------

    function applyResult(result) {
      const out = applyRefresh(pure, result);
      pure = out.state;
      if (result && result.ok === true) renderList();
      if (pure.card) renderCard(out.instr);
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        let r = null;
        try { r = await jget('/api/radar/inbox'); }
        catch (_) { setNote('Could not reach the server.'); applyResult({ ok: false }); return; }
        if (r.status === 401) { setNote('Not authorised.', true); applyResult({ ok: false }); return; }
        if (r.status === 503) { setNote('No snapshot yet.'); applyResult({ ok: false }); return; }
        let data = null;
        try { data = await r.json(); } catch (_) { data = null; }
        if (!r.ok || !data || !Array.isArray(data.items)) { setNote('Could not load the inbox.'); applyResult({ ok: false }); return; }
        snapshot = data;
        const degraded = !!(data.sources && data.sources.classifier === 'degraded');
        // One GLOBAL line, not a per-row warning.
        setNote(degraded ? DEGRADED_COPY : '');
        applyResult({ ok: true, items: data.items });
      } finally { inflight = false; }
    }

    // ---- the refresh predicate --------------------------------------------------------------------
    //
    // Every open, close, tab switch and visibility flip is one reducer event. The reducer is the only
    // producer of a `start`, so "exactly one timer, and only while the predicate holds" is a property
    // of the pure layer rather than a rule this block has to keep.
    function pump(event) {
      const out = refreshReduce(refreshState, event);
      refreshState = out.state;
      if (out.start) refreshState = refreshSetTimer(refreshState, setTimer(function () { tick(); }, REFRESH_MS));
      if (out.stop && out.stopped != null) clearTimer(out.stopped);
      if (out.get) load();
    }

    function tick() {
      const out = refreshReduce(refreshState, { type: 'tick' });
      refreshState = out.state;
      if (out.get) load();
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', function () { pump({ type: 'visible', value: visibleNow() }); });
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    function open() {
      if (opened) return;
      opened = true;
      doc.body.classList.add('mode-inbox');
      renderList();
      // The predicate becoming true is what loads — so an inbox opened while the document is hidden
      // does nothing at all, which is the rule stated as "never while it does not hold".
      pump({ type: 'open' });
    }

    function close() {
      opened = false;
      doc.body.classList.remove('mode-inbox');
      pump({ type: 'close' });
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
      confirm: confirmTap,
      // Tear the timer down explicitly. Nothing in app.js calls it — the inbox lives for the life of
      // the page — but a harness that mounts many inboxes should not leave a cadence behind.
      destroy: function () { pump({ type: 'close' }); },
      // Read-only windows onto the pure state, for the browser harness.
      state: function () { return pure; },
      refreshState: function () { return refreshState; },
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
    // the S-009 pure layer — the §6.1 map, reconciliation, the machine, the predicate reducer
    turnSignature: turnSignature,
    surfaceOf: surfaceOf,
    valueEqual: valueEqual,
    copyForCode: copyForCode,
    reconcileRows: reconcileRows,
    machineInitial: machineInitial,
    machineNotice: machineNotice,
    machineReduce: machineReduce,
    sendEnabled: sendEnabled,
    canSend: canSend,
    openCardState: openCardState,
    instructionsFor: instructionsFor,
    applyCardDecision: applyCardDecision,
    applyRefresh: applyRefresh,
    applyCardRow: applyCardRow,
    applyDraft: applyDraft,
    applySend: applySend,
    applyReplyResult: applyReplyResult,
    applyConfirm: applyConfirm,
    refreshInitial: refreshInitial,
    refreshReduce: refreshReduce,
    refreshSetTimer: refreshSetTimer,
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
    REPLY_COPY: REPLY_COPY,
    REPLY_DISABLE_SEND: REPLY_DISABLE_SEND,
    REPLY_FALLBACK_COPY: REPLY_FALLBACK_COPY,
    REPLY_NON_JSON: REPLY_NON_JSON,
    REPLY_NETWORK_ERROR: REPLY_NETWORK_ERROR,
    REPLY_UNAUTHORIZED: REPLY_UNAUTHORIZED,
    MACHINE_READY: MACHINE_READY,
    MACHINE_AWAITING_FRESH: MACHINE_AWAITING_FRESH,
    MACHINE_RECONFIRM: MACHINE_RECONFIRM,
    QUESTION_CHANGED_REVIEW: QUESTION_CHANGED_REVIEW,
    VANISHED_COPY: VANISHED_COPY,
    REFRESH_FAILED_COPY: REFRESH_FAILED_COPY,
    REFRESH_MS: REFRESH_MS,
    SURFACE_REASON_COPY: SURFACE_REASON_COPY,
    ROW_QUESTION_MAX: ROW_QUESTION_MAX,
  };
});
