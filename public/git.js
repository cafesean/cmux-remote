/* cmux-remote — source control (p7 Track C).
 *
 * Follows the module contract p5 established: self-contained, own DOM, own CSS, mounted defensively
 * by app.js. If this file 404s or throws on create(), the chip is removed and the terminal mirror
 * never knows. window.cmuxGit.create({...}) -> { open, close }.
 *
 * The safety property this UI must not break: NOTHING DESTRUCTIVE RUNS FROM HERE. Stage and unstage
 * are index-only and reversible. Everything else — commit, push, pull, merge, rebase, checkout,
 * discard — is generated as command TEXT and dropped into a pane's composer, unsent. The operator reads it
 * and decides. That is why fillComposer is injected rather than this module posting anywhere.
 */
(function () {
  'use strict';

  const CSS = `
  #gitpanel { position: absolute; inset: 0; z-index: 3; background: var(--bg); display: none; flex-direction: column; overflow: hidden; }
  #gitpanel.on { display: flex; }
  #gitpanel .gbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-bottom: 1px solid var(--line); background: var(--panel); font-size: 13px; }
  #gitpanel .gback { background: none; border: none; color: var(--dim); font: inherit; font-size: 18px; padding: 0 4px; }
  #gitpanel .gtitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
  #gitpanel .gsegs { flex: 0 0 auto; display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  #gitpanel .gseg { background: var(--panel2); color: var(--dim); border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 11px; font: inherit; font-size: 12px; }
  #gitpanel .gseg.on { color: var(--accent); border-color: var(--accent); }
  #gitpanel .gbody { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  #gitpanel .grow { display: flex; align-items: center; gap: 9px; padding: 10px 11px; border-bottom: 1px solid var(--line);
    font-family: var(--mono); font-size: 12.5px; }
  #gitpanel .grow button { background: none; border: none; color: inherit; font: inherit; text-align: left;
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; }
  #gitpanel .gxy { flex: 0 0 auto; width: 2.4em; color: var(--accent); font-weight: 600; }
  #gitpanel .gxy.unmerged { color: var(--bad); }
  #gitpanel .gact { flex: 0 0 auto; background: var(--panel2); border: 1px solid var(--line); color: var(--dim);
    border-radius: 7px; padding: 5px 9px; font-size: 11.5px; }
  #gitpanel .gact[disabled] { opacity: .45; }
  #gitpanel .ghead { padding: 9px 11px 5px; color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  #gitpanel .gnote { padding: 10px 11px; color: var(--faint); font-size: 12px; }
  #gitpanel .gwarn { padding: 9px 11px; background: #3a2a12; color: #ffd8a8; font-size: 12px; }
  #gitpanel .gdiff { margin: 0; padding: 10px 11px; font-family: var(--mono); font-size: 11.5px; white-space: pre;
    overflow-x: auto; line-height: 1.45; }
  #gitpanel .gdiff .add { color: var(--ok); }
  #gitpanel .gdiff .del { color: var(--bad); }
  #gitpanel .gdiff .hunk { color: var(--accent); }
  #gitpanel .gcmds { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 11px; border-top: 1px solid var(--line); }
  #gitpanel .gcmd { background: var(--panel2); border: 1px solid var(--line); color: var(--fg); border-radius: 999px;
    padding: 7px 12px; font: inherit; font-size: 12px; }
  `;

  // STORY-010 (war-game M7b): the marking that rides p8-generated text for a repo the operator only
  // browsed into. Verbatim from gitread.js's BROWSED_TEXT_MARK — a test asserts all three copies
  // (server, bar, panel) are byte-identical, because two doors warning in two different words is
  // the same defect as one door not warning.
  const BROWSED_TEXT_MARK =
    'browsed repo — running this text runs that repo\'s configured programs; the text shows the verb, not the hooks';

  function create(opts) {
    const { mount, jget, jpost, fillComposer, machine } = opts || {};
    if (!mount || !jget || !jpost) throw new Error('cmuxGit.create needs mount, jget, jpost');
    // The status-line seam, injected exactly as the bar's is. Optional and defaulted to a no-op so
    // a host that does not supply it still gets a working panel — but app.js does supply it, and
    // without it the panel's own fills would be the one p8 surface that generates text silently.
    const emitNote = typeof (opts && opts.note) === 'function' ? opts.note : function () {};

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'gitpanel';
    el.innerHTML = '<div class="gbar"><button class="gback" type="button" aria-label="Back">‹</button>'
      + '<span class="gtitle">Source control</span></div>'
      + '<div class="gsegs"></div><div class="gbody"></div><div class="gcmds"></div>';
    mount.appendChild(el);

    const elBar = el.querySelector('.gbar');
    const elBack = el.querySelector('.gback');
    const elTitle = el.querySelector('.gtitle');
    const elSegs = el.querySelector('.gsegs');
    const elBody = el.querySelector('.gbody');
    const elCmds = el.querySelector('.gcmds');

    const st = { repo: null, seg: 'changes', status: null, machineId: null, view: 'repos', src: 'git', notice: null };
    const getMachine = () => (typeof machine === 'function' ? machine() : machine) || st.machineId;

    // TWO DOORS, TWO READ SOURCES — bound at open(), held in PANEL state, never global.
    // The ⎇ toolbar door reads p7's /api/cmux/git/*; the bar door reads p8's /api/cmux/gitread/*.
    // The 'git' branch must keep emitting exactly what shipped — same base, same key order, same
    // `repo=` key — because that disjointness is what makes "the ⎇ journey never touches p8" a
    // property you can read off the requests rather than an argument. The read branch addresses by
    // `dir=`, which is the only key gitread accepts. The source resets to p7's whenever the view
    // returns to the repo list, which is and remains the ⎇ list.
    const base = () => (st.src === 'read' ? '/api/cmux/gitread/' : '/api/cmux/git/');
    const api = (sub, qs) => base() + sub + '?machine=' + encodeURIComponent(getMachine() || '')
      + (qs ? '&' + qs : '');
    // The panel's anchor, spelled the way the bound source addresses it.
    const anchorQs = () => (st.src === 'read' ? 'dir=' : 'repo=') + encodeURIComponent(st.repo);

    async function getJson(sub, qs) {
      const r = await jget(api(sub, qs));
      // The code rides along so a scope refusal can be told from a git failure (§7). The `error`
      // string is unchanged, so every existing note reads exactly as it did.
      if (!r.ok) return { error: 'http_' + r.status, status: r.status };
      return r.json().catch(() => ({ error: 'bad_json' }));
    }

    const note = (msg) => { elBody.replaceChildren(); const d = document.createElement('div'); d.className = 'gnote'; d.textContent = msg; elBody.appendChild(d); };

    // ---- repo list -----------------------------------------------------------------------
    async function showRepos() {
      // The list is the ⎇ list, whichever door opened the panel: returning here resets the read
      // source to p7's (§6.6). Untouched otherwise.
      st.src = 'git';
      st.view = 'repos'; st.repo = null;
      elTitle.textContent = 'Source control';
      elSegs.hidden = true; elCmds.replaceChildren();
      note('Looking for repositories…');
      const d = await getJson('repos');
      if (d.error) return note('Could not list repositories (' + d.error + ')');
      if (!d.repos || !d.repos.length) return note('No git repositories among the open workspaces.');
      elBody.replaceChildren();
      for (const r of d.repos) {
        const row = document.createElement('div'); row.className = 'grow';
        const b = document.createElement('button'); b.type = 'button';
        b.textContent = r.name;
        b.onclick = () => openRepo(r.path, r.name);
        const tag = document.createElement('span'); tag.className = 'gact'; tag.textContent = (r.labels || []).join(', ') || 'repo';
        row.append(b, tag); elBody.appendChild(row);
      }
    }

    function openRepo(repoPath, name) {
      st.repo = repoPath; st.view = 'repo'; st.seg = 'changes';
      elTitle.textContent = name || repoPath;
      elSegs.hidden = false;
      renderSegs();
      refresh();
    }

    function renderSegs() {
      elSegs.replaceChildren();
      for (const [key, label] of [['changes', 'Changes'], ['branches', 'Branches'], ['worktrees', 'Worktrees']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'gseg' + (st.seg === key ? ' on' : ''); b.textContent = label;
        b.onclick = () => { st.seg = key; renderSegs(); refresh(); };
        elSegs.appendChild(b);
      }
    }

    async function refresh() {
      if (!st.repo) return showRepos();
      if (st.seg === 'changes') return showChanges();
      if (st.seg === 'branches') return showBranches();
      return showWorktrees();
    }

    // ---- changes -------------------------------------------------------------------------
    async function showChanges() {
      note('Reading working tree…');
      const d = await getJson('status', anchorQs());
      // §7 governs the panel, not only the bar. p8's read gate can start refusing MID-SESSION, and
      // then the §6.5 healing loop below cannot exit the state it lands in: the refresh 403s too,
      // `canWrite` never updates, the controls rendered from the last good status stay live, every
      // tap fails, and the note blames git for a scope decision. So a status 403 through the BAR's
      // source leaves — panel closed, bar hidden. Gated on the bound source, so the ⎇ door keeps
      // today's note-and-stay behaviour exactly.
      if (st.src === 'read' && d.status === 403) return scopeLost();
      if (d.error) return note('git status failed (' + d.error + ')');
      st.status = d;
      elBody.replaceChildren();
      // A refusal note raised by the write path survives the refresh that same path triggers —
      // otherwise the healing read wipes the only explanation the operator was given.
      if (st.notice) {
        const n = document.createElement('div'); n.className = 'gnote'; n.textContent = st.notice;
        st.notice = null; elBody.appendChild(n);
      }

      if (d.inProgress && (d.inProgress.merge || d.inProgress.rebase)) {
        const w = document.createElement('div'); w.className = 'gwarn';
        w.textContent = (d.inProgress.merge ? 'Merge' : 'Rebase') + ' in progress — staging a conflicted file marks it RESOLVED, markers and all.';
        elBody.appendChild(w);
      }

      const b = d.branch || {};
      const head = document.createElement('div'); head.className = 'gnote';
      head.textContent = (b.detached ? 'detached HEAD' : (b.branch || '(no branch)'))
        + (b.upstream ? ' → ' + b.upstream : ' · no upstream')
        + (b.ahead == null ? ' · ahead/behind unknown' : ` · ahead ${b.ahead}, behind ${b.behind}`);
      elBody.appendChild(head);

      // §6.5: capability-honest, not optimistically armed. One line ABOVE the listing states the
      // boundary, so the rows below can be missing their controls without being mysterious.
      if (d.canWrite === false) {
        const ro = document.createElement('div'); ro.className = 'gnote';
        ro.textContent = 'Read-only here — per-file staging needs a repo from the ⎇ list.';
        elBody.appendChild(ro);
      }

      const groups = [
        ['Unmerged', (f) => f.unmerged],
        ['Staged', (f) => f.staged],
        ['Changes', (f) => f.unstaged && !f.untracked],
        ['Untracked', (f) => f.untracked],
      ];
      let any = false;
      for (const [label, pick] of groups) {
        const files = (d.files || []).filter(pick);
        if (!files.length) continue;
        any = true;
        const h = document.createElement('div'); h.className = 'ghead'; h.textContent = label + ' · ' + files.length;
        elBody.appendChild(h);
        for (const f of files) elBody.appendChild(fileRow(f, label, d.canWrite));
      }
      if (!any) elBody.appendChild(Object.assign(document.createElement('div'), { className: 'gnote', textContent: 'Nothing to commit — working tree clean.' }));
      renderCommands();
    }

    function fileRow(f, group, canWrite) {
      const row = document.createElement('div'); row.className = 'grow';
      const xy = document.createElement('span');
      xy.className = 'gxy' + (f.unmerged ? ' unmerged' : ''); xy.textContent = f.xy;
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = f.from ? f.from + ' → ' + f.path : f.path;
      b.onclick = () => showDiff(f);
      if (f.unmerged) {
        // Enforced on the bridge too — this is the courtesy copy. It survives a read-only render:
        // it is INFORMATION about the file, not a control over it.
        const act = document.createElement('button'); act.type = 'button'; act.className = 'gact';
        act.textContent = 'conflict'; act.disabled = true;
        act.title = 'git add on a conflicted file marks it resolved, conflict markers included';
        row.append(xy, b, act);
        return row;
      }
      // §6.5: `canWrite === false` — and ONLY that shape — removes the control. True or ABSENT
      // renders what shipped, and absent is every ⎇-door status response, since the p7 route
      // carries no such field. Absent rather than disabled-and-mysterious; the reason is one line
      // above. Diff taps are reads and keep working.
      if (canWrite === false) {
        row.append(xy, b);
        return row;
      }
      const act = document.createElement('button'); act.type = 'button'; act.className = 'gact';
      if (group === 'Staged') {
        act.textContent = 'unstage'; act.onclick = () => write('unstage', f.path);
      } else {
        act.textContent = 'stage'; act.onclick = () => write('stage', f.path);
      }
      row.append(xy, b, act);
      return row;
    }

    async function write(verb, path) {
      // ALWAYS the p7 write routes, whichever door opened the panel: one write path in the system,
      // and p7's fresh-enumeration equality gate is its sole authority.
      const r = await jpost('/api/cmux/git/' + verb + '?machine=' + encodeURIComponent(getMachine() || ''),
        { repo: st.repo, paths: [path] });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        note(verb + ' refused: ' + (d.error || r.status));
        // `canWrite` was a point-in-time HINT and the anchor can close between status and tap
        // (§6.5). Re-fetch through the BOUND source so the refreshed hint takes the controls away
        // instead of leaving a row that fails on every tap. Only the read source can carry the
        // field, and only the bar door binds it — the ⎇ door keeps today's note-and-stop, so its
        // request stream stays byte-identical.
        if (st.src === 'read') { st.notice = verb + ' refused: ' + (d.error || r.status); return showChanges(); }
        return;
      }
      showChanges();
    }

    async function showDiff(f) {
      note('Reading diff…');
      const d = await getJson('diff', anchorQs()
        + '&path=' + encodeURIComponent(f.path) + (f.staged ? '&staged=1' : ''));
      elBody.replaceChildren();
      const back = document.createElement('div'); back.className = 'grow';
      const bb = document.createElement('button'); bb.type = 'button'; bb.textContent = '‹ ' + f.path;
      bb.onclick = showChanges; back.appendChild(bb); elBody.appendChild(back);
      if (d.error) return elBody.appendChild(Object.assign(document.createElement('div'), { className: 'gnote', textContent: 'diff failed (' + d.error + ')' }));
      const pre = document.createElement('pre'); pre.className = 'gdiff';
      for (const line of String(d.diff || '').split('\n')) {
        const s = document.createElement('span');
        s.className = line.startsWith('+') && !line.startsWith('+++') ? 'add'
          : line.startsWith('-') && !line.startsWith('---') ? 'del'
          : line.startsWith('@@') ? 'hunk' : '';
        s.textContent = line + '\n';
        pre.appendChild(s);
      }
      elBody.appendChild(pre);
      if (d.truncated) elBody.appendChild(Object.assign(document.createElement('div'),
        { className: 'gnote', textContent: `truncated at ${d.diff.length} of ${d.bytes} bytes` }));
    }

    // ---- branches / worktrees ---------------------------------------------------------------
    async function showBranches() {
      note('Reading branches…');
      const d = await getJson('branches', anchorQs());
      if (d.error) return note('git branch failed (' + d.error + ')');
      elBody.replaceChildren();
      for (const b of d.branches || []) {
        const row = document.createElement('div'); row.className = 'grow';
        const btn = document.createElement('button'); btn.type = 'button';
        btn.textContent = (b.current ? '● ' : '  ') + b.name
          + (b.unpushed == null ? '' : (b.unpushed ? `  ↑${b.unpushed}` : ''))
          + (b.upstream ? '' : '  (no upstream)');
        btn.onclick = () => propose('checkout', { branch: b.name });
        row.appendChild(btn);
        elBody.appendChild(row);
      }
      renderCommands();
    }

    async function showWorktrees() {
      note('Reading worktrees…');
      const d = await getJson('worktrees', anchorQs());
      if (d.error) return note('git worktree failed (' + d.error + ')');
      elBody.replaceChildren();
      for (const w of d.worktrees || []) {
        const row = document.createElement('div'); row.className = 'grow';
        const btn = document.createElement('button'); btn.type = 'button';
        btn.textContent = (w.branch || 'detached') + (w.dirty ? `  ✱${w.dirty}` : '') + (w.prunable ? '  prunable' : '');
        btn.title = w.path;
        row.appendChild(btn);
        elBody.appendChild(row);
      }
      renderCommands();
    }

    // ---- generated commands ------------------------------------------------------------------
    // These NEVER run from here. The panel asks the bridge for the command TEXT and drops it into a
    // pane composer, unsent — so a misread repo costs a glance, not a reset --hard.
    function renderCommands() {
      elCmds.replaceChildren();
      if (!st.repo) return;
      const b = (st.status && st.status.branch) || {};
      const verbs = [
        ['commit', 'Commit', { message: '' }],
        ['push', 'Push', { branch: b.branch }],
        ['pull', 'Pull', {}],
        ['fetch', 'Fetch', {}],
        ['stash', 'Stash', {}],
      ];
      for (const [verb, label, params] of verbs) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'gcmd'; btn.textContent = label;
        btn.onclick = () => propose(verb, params);
        elCmds.appendChild(btn);
      }
    }

    async function propose(verb, params) {
      // p7's body is {verb, params}; p8's is {verb, dir, params} — `dir` is the panel's anchor, and
      // gitread re-resolves it at generation time rather than trusting anything the client holds.
      const r = st.src === 'read'
        ? await jpost(api('command'), { verb, dir: st.repo, params })
        : await jpost(api('command'), { verb, params });
      if (!r.ok) return note('could not build that command');
      const d = await r.json().catch(() => ({}));
      // The resolved identity rides back with p8's text (§6.6). If the anchor now resolves to a
      // different repository, filling would hand the operator a command aimed somewhere they are
      // not looking: note it and re-read status instead. p7 carries no identity, so it cannot check.
      if (st.src === 'read' && d.repo !== st.repo) {
        st.notice = 'that directory now resolves to a different repository';
        st.seg = 'changes'; renderSegs();
        return showChanges();
      }
      if (!d.text) return note('could not build that command');
      const res = fillComposer ? fillComposer(d.text) : { ok: false, reason: 'no composer' };
      if (res && res.ok === false) return note('nothing filled: ' + (res.reason || 'no pane'));
      // STORY-010: mark the text by provenance, at the point the operator reads it — through the
      // injected status seam, never this panel's body, because close() is the next statement and
      // takes the body with it. Only the p8 source carries the field at all; the ⎇ door's `d` has
      // no `provenance`, so gating on the SOURCE keeps p7's journey byte-identical rather than
      // marking every p7 fill by the fail-closed default. `d.text` went to fillComposer untouched.
      if (st.src === 'read' && d.provenance !== 'workspace') emitNote(BROWSED_TEXT_MARK);
      close();
    }

    let onCloseCb = null;
    let onScopeLostCb = null;
    function open(o) {
      const opt = o || {};
      st.machineId = opt.machine || st.machineId;
      // CLOSE STATE IS PER-OPEN, NEVER INHERITED. The conditional assignment this replaces updated
      // the callback only when an open SUPPLIED one — so a bar open that passed none inherited the
      // ⎇ door's callback and closing the bar's panel exited Files to the terminal. Unconditional:
      // every open states its own close behaviour, and neither door can observe the other's.
      onCloseCb = typeof opt.onClose === 'function' ? opt.onClose : null;
      onScopeLostCb = typeof opt.onScopeLost === 'function' ? opt.onScopeLost : null;
      st.notice = null;
      el.classList.add('on');
      if (opt.repo) {
        // Bar door: land on THIS repo under its server-derived display name, reads bound to p8.
        st.src = opt.src === 'read' ? 'read' : 'git';
        return openRepo(opt.repo, opt.name || opt.repo);
      }
      // ⎇ toolbar door: no repo, no source — the list, p7, exactly as it shipped.
      st.src = 'git';
      showRepos();
    }
    function close() {
      el.classList.remove('on');
      if (onCloseCb) onCloseCb();
    }
    // The read gate refused mid-session (§7). Nothing here can recover it, so the panel leaves and
    // tells its opener to drop the bar rather than sit on controls the server will refuse forever.
    function scopeLost() {
      st.notice = null;
      if (onScopeLostCb) onScopeLostCb();
      close();
    }
    elBack.onclick = () => { if (st.view === 'repo') showRepos(); else close(); };

    return { open, close, el, _state: st };
  }

  window.cmuxGit = { create };
})();
