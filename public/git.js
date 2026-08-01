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

  function create(opts) {
    const { mount, jget, jpost, fillComposer, machine } = opts || {};
    if (!mount || !jget || !jpost) throw new Error('cmuxGit.create needs mount, jget, jpost');

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

    const st = { repo: null, seg: 'changes', status: null, machineId: null, view: 'repos' };
    const getMachine = () => (typeof machine === 'function' ? machine() : machine) || st.machineId;
    const api = (sub, qs) => '/api/cmux/git/' + sub + '?machine=' + encodeURIComponent(getMachine() || '')
      + (qs ? '&' + qs : '');

    async function getJson(sub, qs) {
      const r = await jget(api(sub, qs));
      if (!r.ok) return { error: 'http_' + r.status };
      return r.json().catch(() => ({ error: 'bad_json' }));
    }

    const note = (msg) => { elBody.replaceChildren(); const d = document.createElement('div'); d.className = 'gnote'; d.textContent = msg; elBody.appendChild(d); };

    // ---- repo list -----------------------------------------------------------------------
    async function showRepos() {
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
      const d = await getJson('status', 'repo=' + encodeURIComponent(st.repo));
      if (d.error) return note('git status failed (' + d.error + ')');
      st.status = d;
      elBody.replaceChildren();

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
        for (const f of files) elBody.appendChild(fileRow(f, label));
      }
      if (!any) elBody.appendChild(Object.assign(document.createElement('div'), { className: 'gnote', textContent: 'Nothing to commit — working tree clean.' }));
      renderCommands();
    }

    function fileRow(f, group) {
      const row = document.createElement('div'); row.className = 'grow';
      const xy = document.createElement('span');
      xy.className = 'gxy' + (f.unmerged ? ' unmerged' : ''); xy.textContent = f.xy;
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = f.from ? f.from + ' → ' + f.path : f.path;
      b.onclick = () => showDiff(f);
      const act = document.createElement('button'); act.type = 'button'; act.className = 'gact';
      if (f.unmerged) {
        // Enforced on the bridge too — this is the courtesy copy.
        act.textContent = 'conflict'; act.disabled = true;
        act.title = 'git add on a conflicted file marks it resolved, conflict markers included';
      } else if (group === 'Staged') {
        act.textContent = 'unstage'; act.onclick = () => write('unstage', f.path);
      } else {
        act.textContent = 'stage'; act.onclick = () => write('stage', f.path);
      }
      row.append(xy, b, act);
      return row;
    }

    async function write(verb, path) {
      const r = await jpost('/api/cmux/git/' + verb + '?machine=' + encodeURIComponent(getMachine() || ''),
        { repo: st.repo, paths: [path] });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return note(verb + ' refused: ' + (d.error || r.status));
      }
      showChanges();
    }

    async function showDiff(f) {
      note('Reading diff…');
      const d = await getJson('diff', 'repo=' + encodeURIComponent(st.repo)
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
      const d = await getJson('branches', 'repo=' + encodeURIComponent(st.repo));
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
      const d = await getJson('worktrees', 'repo=' + encodeURIComponent(st.repo));
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
      const r = await jpost('/api/cmux/git/command?machine=' + encodeURIComponent(getMachine() || ''), { verb, params });
      if (!r.ok) return note('could not build that command');
      const d = await r.json().catch(() => ({}));
      if (!d.text) return note('could not build that command');
      const res = fillComposer ? fillComposer(d.text) : { ok: false, reason: 'no composer' };
      if (res && res.ok === false) return note('nothing filled: ' + (res.reason || 'no pane'));
      close();
    }

    let onCloseCb = null;
    function open(o) {
      st.machineId = (o && o.machine) || st.machineId;
      if (o && o.onClose) onCloseCb = o.onClose;
      el.classList.add('on');
      showRepos();
    }
    function close() {
      el.classList.remove('on');
      if (onCloseCb) onCloseCb();
    }
    elBack.onclick = () => { if (st.view === 'repo') showRepos(); else close(); };

    return { open, close, el, _state: st };
  }

  window.cmuxGit = { create };
})();
