// p9 S-011 — the deterministic browser suite. Driven by scripts/browser-inbox.mjs; never run alone.
//
// WHAT IS REAL HERE. The page is real: index.html, app.js and inbox.js are served off disk by a real
// `server.js` child and boot exactly as they do in production, through the same Bearer gate and the
// same defensive mount. The inbox tab is opened by CLICKING THE CHIP, and every assertion below
// reads the DOM the operator would see. There is no handle on the inbox instance anywhere in this
// file: nothing is driven through an internal seam, because a seam is precisely what a browser pass
// is supposed to stop trusting.
//
// WHAT IS STUBBED, AND WHY. Three things, each for a stated reason:
//
//   1. `GET /api/radar/inbox` is served by the REAL route from the injected fixture for the list and
//      card ACs — that path is proved end to end. It is route-stubbed only where an AC needs a
//      payload the collector cannot be made to publish on demand (an empty queue, eleven distinct
//      `surfaceReason` values, a turn that changes between two GETs).
//   2. `POST /api/radar/inbox/reply` is ALWAYS stubbed. Its outcomes are the §6.1 table, and a
//      healthy machine will not produce `send_unconfirmed` or `tab_gone` on demand. The route
//      itself is covered for real, and hard, in test/p9-reply-gates.test.js.
//   3. `document.visibilityState` is overridden in an init script, because there is no other way to
//      drive the Page Visibility API from a test — and the refresh predicate is half visibility.
//
// SCOPE. S-008's browser ACs (AC5-AC11) and S-009's fixture-driven browser ACs (AC9-AC14), plus the
// offline service-worker check. S-009 AC15 — the answered-row-gone proof against a real waiting
// session — is NOT here and must not be: it belongs to the operator's HG-1 pass (spec §9), and this
// harness configures no bridge and selects no live session.
//
// Every identifier in every fixture is INVENTED. This repository is public.
const VIEWPORT = { width: 390, height: 844 };

// ---- copy, byte-for-byte from specs.md §5.6 and §6.1 --------------------------------------------
// Written out as literals rather than imported from public/inbox.js on purpose: importing the copy
// from the module under test would make every one of these assertions vacuous.
const COPY = {
  empty: 'Nothing waiting.',
  permission: 'This session is waiting at a permission prompt — open the tab to answer it.',
  heuristic: 'The tab was matched by folder, not identity — open it directly to answer.',
  fallback: "This session can't be answered from here.",
  ambiguous: "More than one terminal matches; the tab can't be identified.",
  noTerminal: 'No terminal could be matched to this session.',
  tabClosed: "This session's tab is closed.",
  sharedCwd: "Several sessions share this folder, so the tab can't be identified.",
  unreachable: "The machine isn't reachable right now.",
  degraded: 'Some sessions could not be classified.',
  waiting: 'The question changed — waiting for the update…',
  review: 'The question changed — review it before sending.',
  replyFallback: "Couldn't send — your reply is still here.",
};

// One per DISABLE CLASS of §6.1, plus the two client-side rows that reach the fallback.
const REPLY_CASES = [
  { code: 'send_failed', status: 502, text: 'Sending failed — nothing was typed into the tab.', disables: false },
  { code: 'not_at_prompt', status: 409, text: "The tab isn't at a Claude prompt right now.", disables: false },
  { code: 'pane_changed', status: 409, text: 'The tab changed while sending — nothing was sent.', disables: false },
  { code: 'tab_gone', status: 409, text: "This session's tab is closed.", disables: true },
  { code: 'send_unconfirmed', status: 502, text: "The send wasn't confirmed — check the tab before retrying.", disables: true },
  { code: 'already_answered', status: 409, text: 'This session is no longer waiting.', disables: true },
  { kind: 'http-401', status: 401, text: COPY.replyFallback, disables: false },
  { kind: 'network', text: COPY.replyFallback, disables: false },
];

// ---- helpers -------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envelope(items, classifier) {
  return { items, generatedAt: '2026-01-02T03:04:05.000Z', sources: { classifier: classifier || 'ok' } };
}

// A read-only row: no tab, no action, and one `surfaceReason` to render copy for.
function readOnlyRow(id, surfaceReason, over) {
  return Object.assign({
    sessionKey: { machine: 'fixture-box', sessionId: id },
    blockedSince: '2026-01-02T03:10:00.000Z',
    lastStopAt: null,
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn: { blockedSince: '2026-01-02T03:10:00.000Z', assistantTs: null },
    repo: 'sample-service',
    worktree: null,
    epic: null,
    question: `A read-only row for ${surfaceReason == null ? 'no reason' : surfaceReason}.`,
    title: `Read-only topic ${id}`,
    titleSource: 'ai',
    intent: { verdict: 'needs-decision', reason: 'ends on a direct question', model: 'fixture-model', at: '2026-01-02T03:10:04.000Z', inferred: true },
    surface: null,
    surfaceReason,
    answerable: false,
    actions: [],
  }, over || {});
}

// An answerable row, for the reply flows. `turn` is the token a POST must echo.
function answerableRow(over) {
  return Object.assign({
    sessionKey: { machine: 'fixture-box', sessionId: 'fixture-inbox-9' },
    blockedSince: '2026-01-02T03:20:00.000Z',
    lastStopAt: '2026-01-02T03:19:41.000Z',
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn: { blockedSince: '2026-01-02T03:20:00.000Z', assistantTs: '2026-01-02T03:19:41.000Z' },
    repo: 'sample-web',
    worktree: null,
    epic: null,
    question: 'Should the migration run in one step or two?',
    title: 'Migration rollout for the sample service',
    titleSource: 'custom',
    intent: { verdict: 'needs-decision', reason: 'ends on a direct question', model: 'fixture-model', at: '2026-01-02T03:20:04.000Z', inferred: true },
    surface: { workspace: 'fixture-workspace', tabRef: 'w0/t9', tabUuid: 'fixture-tab-uuid-9', via: 'recorded' },
    surfaceReason: null,
    answerable: true,
    actions: [{ kind: 'reply' }],
  }, over || {});
}

const rowKeyOf = (row) => JSON.stringify([row.sessionKey.machine, row.sessionKey.sessionId]);

export async function run({ chromium, base, token, fixture, now, log }) {
  const say = typeof log === 'function' ? log : () => {};
  const results = [];
  let failed = 0;

  function check(name, ok, detail) {
    results.push({ name, ok: !!ok });
    if (!ok) failed++;
    say((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || detail === undefined ? '' : '\n        ' + detail));
  }
  const eq = (name, actual, expected) =>
    check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  const FIXTURE_ROWS = fixture.inbox;
  const NOW = now || '2026-01-02T03:59:00.000Z';

  const browser = await chromium.launch();

  // EVERY wait in this file polls from NODE, never from the page.
  //
  // `page.waitForFunction` polls the main world with requestAnimationFrame, and two of the sections
  // below install a fake clock in that world — which patches rAF. A page-side wait would then never
  // tick and the section would hang rather than fail. `page.evaluate` is a single round trip and is
  // immune to it, so the loop lives out here.
  async function waitFor(page, fn, arg, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    for (;;) {
      let v = false;
      try { v = await page.evaluate(fn, arg); } catch (_) { v = false; }
      if (v) return true;
      if (Date.now() > deadline) return false;
      await sleep(80);
    }
  }

  // A context with the token pre-seeded and the Page Visibility API made drivable. `clock` is
  // absent, 'fixed' or 'install': 'fixed' pins Date.now() so relative ages are deterministic;
  // 'install' additionally takes control of page timers, which is the only way to prove a 60-second
  // cadence without spending a minute of wall clock per assertion.
  async function newCtx(opts) {
    const o = opts || {};
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript((t) => {
      try { localStorage.setItem('cmux_token', t); } catch (_) { /* private mode */ }
      // The ONLY way to drive the Page Visibility API from a test. The inbox reads
      // `document.visibilityState` and listens for `visibilitychange`; both are honoured below.
      window.__vis = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' });
    }, token);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // The browser reporting an HTTP status is not a script error, and this harness deliberately
      // points the machine registry at a closed port — every bridge call is MEANT to fail.
      if (/Failed to load resource|bridge_unreachable|net::ERR_/.test(t)) return;
      errors.push('console: ' + t);
    });
    if (o.clock === 'fixed') await page.clock.setFixedTime(new Date(NOW));
    if (o.clock === 'install') await page.clock.install({ time: new Date(NOW) });
    return { context, page, errors, close: () => context.close() };
  }

  async function bootPage(page) {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#inboxBtn', { timeout: 15000 });
    const up = await waitFor(page, () => !!(window.cmuxInbox && window.cmuxInbox.create), null, 15000);
    if (!up) throw new Error('window.cmuxInbox never appeared — /inbox.js did not load or did not execute');
  }

  async function openInbox(page) {
    await page.click('#inboxBtn');
    await page.waitForSelector('body.mode-inbox #inbox', { timeout: 8000 });
    // The list paints only once a GET has landed; before that "nothing fetched yet" is deliberately
    // NOT the empty state.
    await page.waitForSelector('#inbox .irow, #inbox .iempty', { timeout: 8000 });
  }

  // Serve a controlled inbox payload. The predicate form is used rather than a glob so
  // `/api/radar/inbox/reply` can never be swallowed by the list route.
  const routeInbox = (page, handler) =>
    page.route((url) => url.pathname === '/api/radar/inbox', async (route) => {
      const body = await handler();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

  const routeReply = (page, handler) =>
    page.route((url) => url.pathname === '/api/radar/inbox/reply', handler);

  const cardText = (page, sel) => page.$eval(sel, (n) => n.textContent).catch(() => null);
  const count = async (page, sel) => (await page.$$(sel)).length;
  // The card's one inline sentence. Waited for by VALUE, because every §6.1 outcome renders into the
  // same element and "it changed" is not the same claim as "it says this".
  const waitNotice = (page, want) => waitFor(page, (w) => {
    const n = document.querySelector('#inbox .inotice');
    return !!(n && !n.hidden && n.textContent === w);
  }, want, 8000);

  try {
    // ===============================================================================================
    say('\n── S-008 AC5: the inbox is the active tab, and the only one ──');
    // ===============================================================================================
    {
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await bootPage(page);
        const before = await page.evaluate(() => document.body.className);
        check('the chip survived app boot — the inbox mounted', await count(page, '#inboxBtn') === 1, before);

        // Count pane/grid traffic from the moment the inbox opens: "terminal polling stops" is a
        // claim about requests, not about a class name.
        const gridCalls = [];
        page.on('request', (r) => { if (/\/api\/cmux\/(grid|grid-stream|layout-stream)/.test(r.url())) gridCalls.push(r.url()); });

        await openInbox(page);
        const st = await page.evaluate(() => ({
          cls: document.body.className,
          display: getComputedStyle(document.getElementById('inbox')).display,
          inbox: document.getElementById('inboxBtn').getAttribute('aria-pressed'),
          radar: document.getElementById('radarBtn') ? document.getElementById('radarBtn').getAttribute('aria-pressed') : 'absent',
          files: document.getElementById('filesBtn').getAttribute('aria-pressed'),
          git: document.getElementById('gitBtn') ? document.getElementById('gitBtn').getAttribute('aria-pressed') : 'absent',
          panes: document.getElementById('panes').childElementCount,
        }));
        eq('the inbox pane is displayed', st.display, 'flex');
        eq('the inbox chip reads pressed', st.inbox, 'true');
        check('body carries mode-inbox and NO other mode class',
          /\bmode-inbox\b/.test(st.cls) && !/mode-(radar|files|browser|fview)\b/.test(st.cls), st.cls);
        check('Files, Git and Radar are not simultaneously active',
          st.radar !== 'true' && st.files !== 'true' && st.git !== 'true', JSON.stringify(st));
        eq('no terminal pane is left mounted underneath', st.panes, 0);
        await sleep(400);
        eq('and no grid/pane polling happens while the inbox is open', gridCalls.length, 0);

        // Leaving is the other half of "it is a tab": the mode class goes and the chip unpresses.
        await page.click('#inboxBtn');
        await sleep(250);
        const after = await page.evaluate(() => ({
          cls: document.body.className,
          inbox: document.getElementById('inboxBtn').getAttribute('aria-pressed'),
        }));
        check('closing the inbox leaves the tab',
          !/mode-inbox/.test(after.cls) && after.inbox === 'false', JSON.stringify(after));
        check('no page errors through the tab switch', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-008 AC6: the empty state, and oldest-first ordering ──');
    // ===============================================================================================
    {
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await routeInbox(page, () => envelope([]));
        await bootPage(page);
        await openInbox(page);
        eq('an empty queue says exactly one sentence', (await cardText(page, '#inbox .iempty')).trim(), COPY.empty);
        eq('and renders no rows', await count(page, '#inbox .irow'), 0);
        const head = await page.$eval('#inbox .ihead', (n) => n.textContent);
        check('no zero, no badge, no count anywhere in the header', !/\d/.test(head), JSON.stringify(head));
        check('no page errors on the empty state', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }
    {
      // The REAL route, over the injected fixture — the one payload in this suite that travels the
      // whole path: collector state.json -> routeInbox -> jget -> renderList.
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await bootPage(page);
        await openInbox(page);
        eq('the real route serves the three injected fixture rows', await count(page, '#inbox .irow'), 3);
        const keys = await page.$$eval('#inbox .irow', (ns) => ns.map((n) => n.dataset.key));
        check('rows are in the server\'s order — oldest first, never re-sorted by the client',
          JSON.stringify(keys) === JSON.stringify(FIXTURE_ROWS.map(rowKeyOf)), JSON.stringify(keys));
        const ages = await page.$$eval('#inbox .irow .iage', (ns) => ns.map((n) => n.textContent.trim()));
        check('each row shows its own relative age, and the three are distinct',
          ages.length === 3 && new Set(ages).size === 3, JSON.stringify(ages));
        eq('the oldest row is the oldest age', ages[0], '59m');
        eq('and the newest is the newest', ages[2], '9m');

        // The topic. A queue of questions with no topics is unreadable past one row, so assert the
        // real rendered text — and assert the UNTITLED row renders no topic element at all, because
        // "every row shows a topic" would also pass if the renderer invented one.
        const topics = await page.$$eval('#inbox .irow', (ns) => ns.map((n) => {
          const t = n.querySelector('.itopic');
          return t ? { text: t.textContent.trim(), own: /itopic-own/.test(t.className) } : null;
        }));
        eq('the renamed row shows the operator\'s own title', topics[0] && topics[0].text, 'fixture-renamed-by-operator');
        check('…and it is marked as the operator\'s, not the titler\'s', topics[0] && topics[0].own === true, JSON.stringify(topics[0]));
        eq('the untitled row renders NO topic element', topics[1], null);
        eq('the auto-titled row shows the titler\'s topic', topics[2] && topics[2].text, 'Split the migration in two');
        check('…and is NOT marked as the operator\'s', topics[2] && topics[2].own === false, JSON.stringify(topics[2]));
        // The row the operator recognised by its topic must still say so once opened.
        await page.click('#inbox .irow');
        await page.waitForSelector('#inbox .icard .iquestion', { timeout: 5000 });
        eq('opening a card keeps the topic in the header', (await cardText(page, '#inbox .ititle')).trim(),
          'fixture-renamed-by-operator');
        await page.click('#inbox .iback');
        await sleep(60);
        check('no page errors on the fixture list', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-008 AC7 + S-009 AC14: markers, and ONE global degraded line ──');
    // ===============================================================================================
    {
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await bootPage(page);
        await openInbox(page);
        const marks = await page.$$eval('#inbox .irow', (ns) => ns.map((n) => {
          const m = n.querySelector('.imark');
          return { key: n.dataset.key, mark: m ? m.textContent.trim() : null };
        }));
        const byId = (id) => (marks.find((m) => m.key.includes(id)) || {}).mark;
        eq('a needs-decision row is marked inferred, never presented as measured', byId('fixture-inbox-1'), 'inferred');
        eq('an unknown row is SHOWN and marked unclassified', byId('fixture-inbox-2'), 'unclassified');
        check('the unknown row is not hidden — it is a real row with a real question',
          (await page.$$('#inbox .irow[data-key*="fixture-inbox-2"] .iq')).length === 1);

        // S-009 AC14. The fixture carries one `unknown` verdict, so the REAL route computes
        // `classifier: degraded` — this line is not stubbed into existence.
        const note = await page.$eval('#inbox .inote', (n) => ({ hidden: n.hidden, text: n.textContent.trim() }));
        check('a degraded classifier renders ONE global line', note.hidden === false && note.text === COPY.degraded, JSON.stringify(note));
        const perRow = await page.$$eval('#inbox .irow', (ns, want) => ns.filter((n) => n.textContent.includes(want)).length, COPY.degraded);
        eq('and no per-row warning anywhere', perRow, 0);
        eq('the global line appears exactly once', await count(page, '#inbox .inote'), 1);
        check('no page errors on the degraded board', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-008 AC8: the full question is reachable, never clamped ──');
    // ===============================================================================================
    {
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await bootPage(page);
        await openInbox(page);
        const full = FIXTURE_ROWS[0].question;
        check('the fixture really is a long question', full.length > 2000, String(full.length));

        // The ROW is a preview and the only place the text is ever shortened.
        const preview = (await page.$eval('#inbox .irow .iq', (n) => n.textContent)).trim();
        check('the row shows a truncated one-line preview', preview.length <= 205 && preview.endsWith('…'), JSON.stringify(preview.slice(-40)));

        await page.click('#inbox .irow');
        await page.waitForSelector('#inbox .iquestion', { timeout: 5000 });
        const q = await page.$eval('#inbox .iquestion', (n) => ({
          len: n.textContent.length,
          head: n.textContent.slice(0, 48),
          tail: n.textContent.slice(-48),
          scrollable: n.scrollHeight > n.clientHeight + 1,
          clamp: getComputedStyle(n).webkitLineClamp,
          overflowText: getComputedStyle(n).textOverflow,
          overflowY: getComputedStyle(n).overflowY,
        }));
        eq('the card carries the COMPLETE question, byte for byte', q.len, full.length);
        eq('…including its last words', q.tail, full.slice(-48));
        check('the question pane scrolls', q.scrollable && /auto|scroll/.test(q.overflowY), JSON.stringify(q));
        check('and is never clamped or ellipsised',
          (q.clamp === 'none' || q.clamp === '' || q.clamp === undefined) && q.overflowText === 'clip', JSON.stringify(q));
        const scrolled = await page.$eval('#inbox .iquestion', (n) => { n.scrollTop = n.scrollHeight; return n.scrollTop; });
        check('the end of the text is reachable by scrolling', scrolled > 0, String(scrolled));
        check('no page errors on the long card', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-008 AC9/AC10/AC11: every read-only card in the vocabulary ──');
    // ===============================================================================================
    {
      // Eight literals + TWO CONCRETE members of the `ambiguous-tabs:<n>` value family + one value
      // the table has never heard of. The family is the trap: matching the placeholder string would
      // send every concrete count to the fallback and tell the operator nothing.
      const cases = [
        { id: 'fixture-inbox-20', reason: 'recorded-tab-gone', want: COPY.tabClosed },
        { id: 'fixture-inbox-21', reason: 'shared-cwd', want: COPY.sharedCwd },
        { id: 'fixture-inbox-22', reason: 'ambiguous-workspace', want: COPY.ambiguous },
        { id: 'fixture-inbox-23', reason: 'no-workspace-for-cwd', want: COPY.noTerminal },
        { id: 'fixture-inbox-24', reason: 'no-cwd', want: COPY.noTerminal },
        { id: 'fixture-inbox-25', reason: 'no-terminal-tab', want: COPY.noTerminal },
        { id: 'fixture-inbox-26', reason: 'no-tab-uuid', want: COPY.noTerminal },
        { id: 'fixture-inbox-27', reason: 'tree-unavailable', want: COPY.unreachable },
        { id: 'fixture-inbox-28', reason: 'ambiguous-tabs:2', want: COPY.ambiguous },
        { id: 'fixture-inbox-29', reason: 'ambiguous-tabs:4', want: COPY.ambiguous },
        { id: 'fixture-inbox-30', reason: 'fixture-reason-nobody-mapped', want: COPY.fallback },
      ];
      // AC10: a heuristic join. The tab is ALIVE and recorded in `surface`, and it is still read-only,
      // because a folder match is not an identity match.
      const heuristic = readOnlyRow('fixture-inbox-31', null, {
        surface: { workspace: 'fixture-workspace', tabRef: 'w0/t31', tabUuid: 'fixture-tab-uuid-31', via: 'cwd' },
        question: 'A row joined by folder, not identity.',
      });
      // AC11: a live, recorded tab waiting at a permission MENU. Read-only for a different reason
      // entirely, and the reason outranks every surface consideration.
      const permission = readOnlyRow('fixture-inbox-32', null, {
        notificationType: 'permission_request',
        surface: { workspace: 'fixture-workspace', tabRef: 'w0/t32', tabUuid: 'fixture-tab-uuid-32', via: 'recorded' },
        question: 'Allow the tool to write to that path?',
      });
      const rows = cases.map((c) => readOnlyRow(c.id, c.reason)).concat([heuristic, permission]);

      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        await routeInbox(page, () => envelope(rows));
        await bootPage(page);
        await openInbox(page);
        eq('every read-only row is listed — none is hidden', await count(page, '#inbox .irow'), rows.length);

        const openRow = async (id) => {
          await page.click(`#inbox .irow[data-key*="${id}"]`);
          await page.waitForSelector('#inbox .ireadonly', { state: 'attached', timeout: 5000 });
          await sleep(60);
          return page.evaluate(() => ({
            readOnly: document.querySelector('#inbox .ireadonly').textContent,
            readOnlyHidden: document.querySelector('#inbox .ireadonly').hidden,
            fields: document.querySelectorAll('#inbox .ifield textarea').length,
            sends: document.querySelectorAll('#inbox .isend').length,
            buttons: document.querySelectorAll('#inbox .icard button').length,
          }));
        };
        const back = async () => { await page.click('#inbox .iback'); await sleep(60); };

        for (const c of cases) {
          const got = await openRow(c.id);
          eq(`surfaceReason ${c.reason} renders its own sentence`, got.readOnly, c.want);
          check(`surfaceReason ${c.reason}: no reply field, no send, no action of any kind`,
            got.fields === 0 && got.sends === 0 && got.buttons === 0 && got.readOnlyHidden === false, JSON.stringify(got));
          await back();
        }
        // Only ONE value in the whole vocabulary means the tab is closed. If the others drifted onto
        // that sentence an operator would go looking in the wrong place.
        const closedSayers = cases.filter((c) => c.want === COPY.tabClosed).map((c) => c.reason);
        check('exactly one surfaceReason says the tab is closed',
          closedSayers.length === 1 && closedSayers[0] === 'recorded-tab-gone', JSON.stringify(closedSayers));

        const h = await openRow('fixture-inbox-31');
        eq('AC10: a via:"cwd" join is read-only with the heuristic sentence, byte for byte', h.readOnly, COPY.heuristic);
        check('AC10: …and offers no action even though its tabUuid is live',
          h.fields === 0 && h.sends === 0 && h.buttons === 0, JSON.stringify(h));
        await back();

        const p = await openRow('fixture-inbox-32');
        eq('AC11: a permission prompt is read-only with the permission sentence', p.readOnly, COPY.permission);
        check('AC11: …and offers no action even with a live recorded tab',
          p.fields === 0 && p.sends === 0 && p.buttons === 0, JSON.stringify(p));
        await back();

        check('no page errors across the read-only vocabulary', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-009 AC10: a successful reply ──');
    // ===============================================================================================
    {
      const row = answerableRow();
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        const posts = [];
        await routeInbox(page, () => envelope([row]));
        await routeReply(page, async (route) => {
          posts.push(JSON.parse(route.request().postData() || '{}'));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        });
        await bootPage(page);
        await openInbox(page);
        await page.click('#inbox .irow');
        await page.waitForSelector('#inbox .ifield textarea', { timeout: 5000 });
        await page.fill('#inbox .ifield textarea', 'two steps, please');
        await sleep(60);
        eq('send is live on an answerable row with text typed', await page.$eval('#inbox .isend', (n) => n.disabled), false);
        await page.click('#inbox .isend');
        // `state: 'hidden'` is load-bearing, not tidiness. waitForSelector defaults to 'visible', so
        // this line used to wait for a card that was SIMULTANEOUSLY [hidden] and visible — and it
        // passed, every run, because that contradiction was the bug. Once the panel enforces the
        // hidden attribute the default would time out on correct behaviour.
        await page.waitForSelector('#inbox .icard', { state: 'hidden', timeout: 5000 });

        // `.hidden` is the ATTRIBUTE, and asserting it alone is how a visibly-broken card shipped: it
        // was always true while `#inbox .icard{display:flex}` kept the box painted, because
        // `[hidden]{display:none}` is a UA rule any author `display` beats. So assert the RENDERED
        // BOX — computed display and a null offsetParent — which is the thing the operator sees.
        const after = await page.evaluate(() => {
          const card = document.querySelector('#inbox .icard');
          return {
            cardHidden: card.hidden,
            cardDisplay: getComputedStyle(card).display,
            cardPainted: card.offsetParent !== null || card.getClientRects().length > 0,
            listHidden: document.querySelector('#inbox .ilist').hidden,
            fields: document.querySelectorAll('#inbox .ifield textarea').length,
            rows: document.querySelectorAll('#inbox .irow').length,
          };
        });
        check('the card closes and the field is gone', after.cardHidden === true && after.fields === 0, JSON.stringify(after));
        check('and the closed card is NOT RENDERED — no stale question left under the list',
          after.cardDisplay === 'none' && after.cardPainted === false, JSON.stringify(after));
        check('the list comes back', after.listHidden === false, JSON.stringify(after));
        eq('and the ROW remains — never optimistically hidden', after.rows, 1);
        // A reply that changes nothing on screen reads as a reply that did nothing. The row stays, so
        // the CONFIRMATION has to be visible on it — the operator's act, not a claim about the session.
        const marked = await page.evaluate(() => {
          const r = document.querySelector('#inbox .irow');
          const chip = r && r.querySelector('.ireplied');
          return { chip: chip ? chip.textContent.trim() : null, rowClass: r ? r.className : null };
        });
        eq('the answered row is visibly marked replied', marked.chip, 'replied');
        check('…and the row itself carries the replied state', /irow-replied/.test(marked.rowClass || ''), JSON.stringify(marked));
        eq('exactly one POST was made', posts.length, 1);
        check('carrying the row\'s own turn token verbatim',
          JSON.stringify(posts[0].turn) === JSON.stringify(row.turn) && posts[0].text === 'two steps, please',
          JSON.stringify(posts[0]));
        check('no page errors on the success path', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-009 AC11: the §6.1 table inline, with the draft always kept ──');
    // ===============================================================================================
    {
      const row = answerableRow();
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        let current = REPLY_CASES[0];
        await routeInbox(page, () => envelope([row]));
        await routeReply(page, async (route) => {
          if (current.kind === 'network') return route.abort('connectionrefused');
          if (current.kind === 'http-401') return route.fulfill({ status: 401, contentType: 'text/plain', body: 'unauthorized' });
          return route.fulfill({
            status: current.status, contentType: 'application/json',
            body: JSON.stringify({ error: current.code, message: 'server text the client must never render' }),
          });
        });
        await bootPage(page);
        await openInbox(page);

        for (const c of REPLY_CASES) {
          current = c;
          const label = c.code || c.kind;
          const draft = `draft for ${label}`;
          // A fresh card per case: a disabling outcome LATCHES send for that card by design, so
          // reusing one card would make every later case pass for the wrong reason.
          await page.click('#inbox .irow');
          await page.waitForSelector('#inbox .ifield textarea', { timeout: 5000 });
          await page.fill('#inbox .ifield textarea', draft);
          await sleep(60);
          await page.click('#inbox .isend');
          await waitNotice(page, c.text);
          await sleep(80);

          const got = await page.evaluate(() => ({
            notice: document.querySelector('#inbox .inotice').textContent,
            noticeHidden: document.querySelector('#inbox .inotice').hidden,
            draft: (document.querySelector('#inbox .ifield textarea') || {}).value,
            disabled: (document.querySelector('#inbox .isend') || {}).disabled,
            cardHidden: document.querySelector('#inbox .icard').hidden,
          }));
          eq(`${label}: the client's OWN sentence renders inline`, got.notice, c.text);
          check(`${label}: the card stays open with the sentence visible`,
            got.cardHidden === false && got.noticeHidden === false, JSON.stringify(got));
          eq(`${label}: the typed text is still there`, got.draft, draft);
          eq(`${label}: send is ${c.disables ? 'disabled' : 'still live'}`, got.disabled, c.disables);
          check(`${label}: the server's own text is never rendered`,
            !/server text the client must never render/.test(got.notice), got.notice);
          await page.click('#inbox .iback');
          await sleep(60);
        }
        check('no page errors across the §6.1 table', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-009 AC12: question_changed → awaiting-fresh → reconfirm → tap → fresh turn ──');
    // ===============================================================================================
    {
      const first = answerableRow();
      const second = answerableRow({
        blockedSince: '2026-01-02T03:40:00.000Z',
        lastStopAt: '2026-01-02T03:39:30.000Z',
        turn: { blockedSince: '2026-01-02T03:40:00.000Z', assistantTs: '2026-01-02T03:39:30.000Z' },
        question: 'Actually — should the migration be reversible as well?',
      });
      const { page, errors, close } = await newCtx({ clock: 'fixed' });
      try {
        const posts = [];
        let gets = 0;
        await routeInbox(page, async () => {
          gets++;
          // The FIRST GET is the one that opened the tab. The SECOND is the single immediate GET the
          // machine emits on `question_changed`, and it is what delivers the new turn. Delayed so
          // the awaiting-fresh notice is observable rather than a frame nobody could catch.
          if (gets >= 2) { await sleep(500); return envelope([second]); }
          return envelope([first]);
        });
        await routeReply(page, async (route) => {
          posts.push(JSON.parse(route.request().postData() || '{}'));
          if (posts.length === 1) {
            return route.fulfill({
              status: 409, contentType: 'application/json',
              body: JSON.stringify({ error: 'question_changed', message: COPY.waiting }),
            });
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        });
        await bootPage(page);
        await openInbox(page);
        await page.click('#inbox .irow');
        await page.waitForSelector('#inbox .ifield textarea', { timeout: 5000 });
        await page.fill('#inbox .ifield textarea', 'one step');
        await sleep(60);
        await page.click('#inbox .isend');

        // 1. awaiting-fresh: the WAITING sentence, send dead, draft intact, old question still shown.
        check('the awaiting-fresh notice appeared', await waitNotice(page, COPY.waiting));
        const waiting = await page.evaluate(() => ({
          notice: document.querySelector('#inbox .inotice').textContent,
          question: document.querySelector('#inbox .iquestion').textContent,
          draft: document.querySelector('#inbox .ifield textarea').value,
          disabled: document.querySelector('#inbox .isend').disabled,
        }));
        eq('the awaiting-fresh notice renders FIRST', waiting.notice, COPY.waiting);
        eq('…with the draft untouched', waiting.draft, 'one step');
        eq('…and send disabled', waiting.disabled, true);
        eq('…and the question still the one that was answered', waiting.question, first.question);

        // 2. the fresh turn arrives on that one immediate GET -> reconfirm-required, in place.
        check('the fresh turn arrived and the card re-rendered', await waitNotice(page, COPY.review));
        const arrived = await page.evaluate(() => ({
          notice: document.querySelector('#inbox .inotice').textContent,
          tappable: document.querySelector('#inbox .inotice').getAttribute('role'),
          question: document.querySelector('#inbox .iquestion').textContent,
          draft: document.querySelector('#inbox .ifield textarea').value,
          disabled: document.querySelector('#inbox .isend').disabled,
        }));
        eq('the review sentence replaces the waiting one', arrived.notice, COPY.review);
        eq('the NEW question re-renders in place', arrived.question, second.question);
        eq('the draft is still intact', arrived.draft, 'one step');
        eq('send is STILL disabled until the operator looks', arrived.disabled, true);
        eq('the notice is a control now', arrived.tappable, 'button');
        eq('exactly one POST so far', posts.length, 1);

        // 3. one explicit tap -> ready. 4. the retry carries the FRESH token.
        await page.click('#inbox .inotice');
        await sleep(120);
        eq('the tap re-enables send', await page.$eval('#inbox .isend', (n) => n.disabled), false);
        await page.click('#inbox .isend');
        check('the retry succeeded and the card closed',
          await waitFor(page, () => document.querySelector('#inbox .icard').hidden, null, 8000));

        eq('a second POST went out', posts.length, 2);
        check('and it carries the FRESH turn, never the stale one',
          JSON.stringify(posts[1].turn) === JSON.stringify(second.turn), JSON.stringify(posts[1].turn));
        check('the stale token appears in NO post after the first',
          posts.slice(1).every((p) => JSON.stringify(p.turn) !== JSON.stringify(first.turn)), JSON.stringify(posts));
        eq('with the draft the operator typed, verbatim', posts[1].text, 'one step');
        eq('exactly two GETs — the open, and the ONE immediate refresh', gets, 2);
        check('no page errors through the question_changed machine', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-009 AC9: focus and caret survive real refreshes ──');
    // ===============================================================================================
    {
      const row = answerableRow();
      // `install` takes over page timers. It is the only way to let the REAL 60-second cadence and
      // the REAL 5-second tree poll elapse without spending three minutes of wall clock on one AC —
      // and the assertion is about what those real timers do to a focused textarea.
      const { page, errors, close } = await newCtx({ clock: 'install' });
      try {
        let gets = 0;
        await routeInbox(page, () => { gets++; return envelope([row]); });
        await bootPage(page);
        await openInbox(page);
        await page.click('#inbox .irow');
        await page.waitForSelector('#inbox .ifield textarea', { timeout: 5000 });
        await page.fill('#inbox .ifield textarea', 'half a sentence typed');
        await page.focus('#inbox .ifield textarea');
        await page.$eval('#inbox .ifield textarea', (n) => { n.selectionStart = 4; n.selectionEnd = 4; });
        const nodeId = await page.$eval('#inbox .ifield textarea', (n) => { n.dataset.probe = 'p9-focus-probe'; return n.dataset.probe; });
        eq('the probe is on the mounted field', nodeId, 'p9-focus-probe');
        const getsBefore = gets;

        for (let i = 0; i < 3; i++) { await page.clock.runFor(60000); await sleep(250); }

        const after = await page.evaluate(() => {
          const ta = document.querySelector('#inbox .ifield textarea');
          return {
            focused: document.activeElement === ta,
            caret: ta.selectionStart,
            value: ta.value,
            sameNode: ta.dataset.probe === 'p9-focus-probe',
            fields: document.querySelectorAll('#inbox .ifield textarea').length,
          };
        });
        check('three real 60 s refreshes elapsed', gets - getsBefore >= 3, `${getsBefore} -> ${gets}`);
        check('the SAME textarea node is still mounted — appendChild never moved it', after.sameNode && after.fields === 1, JSON.stringify(after));
        eq('focus survived', after.focused, true);
        eq('the caret did not move', after.caret, 4);
        eq('and the typed text is unchanged', after.value, 'half a sentence typed');
        check('no page errors through the refreshes', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── S-009 AC13: the refresh predicate, on real timers ──');
    // ===============================================================================================
    {
      const row = answerableRow();
      const { page, errors, close } = await newCtx({ clock: 'install' });
      try {
        let gets = 0;
        await routeInbox(page, () => { gets++; return envelope([row]); });
        await bootPage(page);
        await sleep(200);
        eq('an inbox that was never opened fetches nothing', gets, 0);

        await openInbox(page);
        await sleep(200);
        eq('opening fetches once, immediately', gets, 1);

        await page.clock.runFor(60000); await sleep(250);
        eq('active + visible fetches again at 60 s', gets, 2);
        await page.clock.runFor(60000); await sleep(250);
        eq('…and again at 120 s', gets, 3);

        // A different tab active: the predicate drops, the timer is cleared, and a late tick that
        // lands anyway must not become a load.
        await page.click('#inboxBtn');
        await sleep(200);
        const afterClose = gets;
        await page.clock.runFor(180000); await sleep(250);
        eq('a different tab active fetches NEVER', gets, afterClose);

        await openInbox(page);
        await sleep(200);
        eq('reopening fetches once', gets, afterClose + 1);
        const beforeHide = gets;
        await page.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
        await sleep(200);
        await page.clock.runFor(180000); await sleep(250);
        eq('hidden fetches NEVER, however long it stays hidden', gets, beforeHide);

        await page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
        await sleep(300);
        eq('returning to visible fetches ONCE, immediately', gets, beforeHide + 1);
        const beforeSettle = gets;
        await sleep(400);
        eq('…and exactly once — the predicate does not arm two timers', gets, beforeSettle);
        await page.clock.runFor(60000); await sleep(250);
        eq('after which the 60 s cadence resumes, singly', gets, beforeSettle + 1);
        check('no page errors through the predicate', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }

    // ===============================================================================================
    say('\n── the offline check: /inbox.js from the sw cache, through the PATHNAME branch ──');
    // ===============================================================================================
    {
      const { page, context, errors, close } = await newCtx({});
      try {
        // The tag in the SERVED html — the `?v=` lives here and ONLY here.
        const html = await (await fetch(base + '/')).text();
        const tag = /<script src="(\/inbox\.js[^"]*)"><\/script>/.exec(html);
        check('index.html carries a VERSIONED /inbox.js tag', !!tag && /\?v=/.test(tag[1]), tag ? tag[1] : 'no tag');
        const appAt = html.indexOf('/app.js');
        const inboxAt = html.indexOf('/inbox.js');
        check('…and it is before app.js, so window.cmuxInbox exists at app boot',
          inboxAt > -1 && appAt > -1 && inboxAt < appAt, `inbox@${inboxAt} app@${appAt}`);

        await bootPage(page);
        // Wait for the sw to install, claim this page, and finish precaching the shell.
        check('the service worker took control of the page',
          await waitFor(page, () => !!navigator.serviceWorker.controller, null, 25000));
        check('and precached the inbox script',
          await waitFor(page, async () => {
            for (const k of await caches.keys()) {
              const c = await caches.open(k);
              if (await c.match('/inbox.js')) return true;
            }
            return false;
          }, null, 25000));

        // §5.6, asserted on the ACTUAL cache keys rather than on the shell URL happening to equal the
        // tag: the precache entry is the BARE pathname. A query-bearing key would leave nothing the
        // fetch branch's pathname match could find, and the first offline load would 503.
        const cached = await page.evaluate(async () => {
          const out = [];
          for (const k of await caches.keys()) {
            const c = await caches.open(k);
            for (const req of await c.keys()) {
              const u = new URL(req.url);
              out.push({ cache: k, pathname: u.pathname, search: u.search });
            }
          }
          return out;
        });
        const inboxKeys = cached.filter((e) => e.pathname === '/inbox.js');
        check('the precache key for the inbox script is the BARE /inbox.js',
          inboxKeys.length === 1 && inboxKeys[0].search === '', JSON.stringify(cached));
        check('no query-bearing /inbox.js key exists in any cache',
          cached.every((e) => !(e.pathname === '/inbox.js' && e.search !== '')), JSON.stringify(cached));

        // Sever the network. Everything from here has to come out of Cache Storage or not at all.
        const served = [];
        page.on('response', (r) => {
          const u = new URL(r.url());
          if (u.pathname === '/inbox.js' || u.pathname === '/app.js' || u.pathname === '/') {
            served.push({ pathname: u.pathname, search: u.search, status: r.status(), sw: typeof r.fromServiceWorker === 'function' ? r.fromServiceWorker() : null });
          }
        });
        await context.setOffline(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        check('the page booted with the network severed',
          await waitFor(page, () => !!(window.cmuxInbox && window.cmuxInbox.create), null, 20000));

        const offlineScript = served.find((s) => s.pathname === '/inbox.js');
        check('with the network severed, /inbox.js was still served', !!offlineScript && offlineScript.status === 200, JSON.stringify(served));
        check('…by the SERVICE WORKER, not the network', !!offlineScript && offlineScript.sw === true, JSON.stringify(offlineScript));
        check('…for a request that carried the versioned ?v= from the tag',
          !!offlineScript && /^\?v=/.test(offlineScript.search), JSON.stringify(offlineScript));
        check('the shell itself came from the sw too', served.some((s) => s.pathname === '/' && s.sw === true), JSON.stringify(served));
        // The cached script actually EXECUTED — a 200 that never ran would be a hollow pass.
        const live = await page.evaluate(() => ({
          factory: typeof window.cmuxInbox.create,
          copy: window.cmuxInbox.EMPTY_TEXT,
          chip: !!document.getElementById('inboxBtn'),
        }));
        eq('the cached module executed and exposes its factory', live.factory, 'function');
        eq('…and it is the real module, not a stub', live.copy, COPY.empty);
        eq('…and the app still mounted the inbox chip offline', live.chip, true);
        await context.setOffline(false);
        check('no page errors offline', errors.length === 0, errors.join('\n        '));
      } finally { await close(); }
    }
  } finally {
    await browser.close();
  }

  return { passed: results.length - failed, failed, results };
}
