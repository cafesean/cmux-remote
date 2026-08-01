/* cmux-remote — live-menu detection over a cmux render grid (p7 §6.1).
 *
 * Dual-export: the browser gets `window.cmuxMenuParse`, `node --test` gets `module.exports`.
 * Pure — no DOM, no network, no cmux. Every rule below was MEASURED against captured grids in
 * test/fixtures/grids (see scripts/capture-grid.js), not reasoned about. What the measurements said:
 *
 *   1. Claude Code marks the selected menu row with FOREGROUND COLOUR ONLY (#B1B9F9 against a
 *      #999999 field). Not `inverse`, not `background` — those are zero across every Claude grid
 *      captured. A detector keyed on inverse/background finds nothing.
 *   2. ONE MENU ITEM IS TWO GRID ROWS: the item, then its wrapped description at a deep indent.
 *      Pressing Down once moved the highlight from rows 12-13 to rows 14-15. Counting grid rows as
 *      arrow steps is therefore wrong by a factor of two, and would select the wrong command.
 *   3. The `❯` glyph lives on the INPUT LINE, not on any menu item — between two `───` rules. That
 *      three-row shape is the resting state of every idle Claude tab, and it is what a naive
 *      marker-glyph rule fires on. Chips on an idle tab are one tap away from `up`+`enter`, which
 *      in Claude's input means recall-history then RESUBMIT. Hence: glyphs never mark a selection.
 *   4. A themed shell prompt (powerlevel10k) carries a NON-DEFAULT BACKGROUND. Background-difference
 *      alone marks every prompt line in the mirror.
 *
 * The gate is deliberately narrow. A false negative costs a missing convenience; a false positive
 * costs keystrokes sent into a live agent session.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cmuxMenuParse = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  // Rows made only of these are chrome (box rules, separators), never options.
  const RULE_RE = /^[\s─-╿▀-▟=_-]*$/;
  // Cursor pointers. Present for completeness of the row model — they are NOT a selection signal.
  const MARKER_GLYPHS = '❯▶►▸➤»‣';

  const MAX_RUN_ROWS = 40;       // a run longer than this is program output, not a menu
  const MAX_GAP_AFTER_CURSOR = 4; // measured: Claude's menu starts 2 rows below the cursor line
  // Three, not two. An idle Claude tab's status footer under the input box ("Opus 5 … 0 tokens" /
  // "⏸ manual mode on") is exactly two rows, and it satisfies every other rule — it was detected as
  // a menu until this bound went in. Claude's real menus are long. A genuine two-option menu is
  // therefore missed, which costs a convenience; the alternative costs keystrokes in a live agent.
  const MIN_ITEMS = 3;
  const CONT_INDENT_DELTA = 8;   // a row indented this much deeper than the item column is a wrap

  function firstGlyph(s) { const t = (s || '').replace(/^\s+/, ''); return t ? t[0] : ''; }

  // ---- grid -> row model ------------------------------------------------------------------------

  // The default background is the one covering the most CELLS, not style id 0: on a short grid a
  // themed prompt can outnumber the terminal's own background, and id 0 is not guaranteed default.
  function defaultBackground(grid) {
    const byId = styleMap(grid);
    const weight = new Map();
    for (const sp of spansOf(grid) || []) {
      const st = byId.get(sp.style_id);
      if (!st) continue;
      weight.set(st.background, (weight.get(st.background) || 0) + (sp.text || '').length);
    }
    let best = null, bestN = -1;
    for (const [bg, n] of weight) if (n > bestN) { bestN = n; best = bg; }
    return best;
  }

  const styleMap = (grid) => new Map((grid.styles || []).map((s) => [s.id, s]));

  // cmux's own replay calls them `row_spans`; the bridge normalises to `spans` (and folds scrollback
  // in). Both shapes reach this function — fixtures carry the raw one, the live client carries the
  // bridge one — and reading only the raw name is why the detector worked against every fixture and
  // found nothing at all in the browser.
  const spansOf = (grid) => (grid && (grid.row_spans || grid.spans)) || null;

  function buildRows(grid) {
    const byId = styleMap(grid);
    const defBg = defaultBackground(grid);
    const rows = new Map();
    for (const sp of spansOf(grid) || []) {
      let r = rows.get(sp.row);
      if (!r) { r = { row: sp.row, cells: [], indent: null, fg: new Set(), bgOff: false, inverse: false }; rows.set(sp.row, r); }
      const st = byId.get(sp.style_id) || {};
      const text = sp.text || '';
      // Spans are POSITIONED runs, so they must be placed at their column — not concatenated.
      // cmux emits a selected row as one span and an unselected row word-by-word, so concatenation
      // silently deleted the gaps on unselected rows only: the same menu item read differently
      // before and after a Down press, which would break the §6.1 read-back that compares them.
      for (let i = 0; i < text.length; i++) r.cells[sp.column + i] = text[i];
      if (r.indent === null && text.trim()) r.indent = sp.column + text.search(/\S/);
      // Colour is only a signal where there are GLYPHS to colour. Claude pads rows with whitespace
      // spans carrying #FFFFFF; counting those made the selected row look identical to its
      // neighbour and broke selection detection on the frame after a Down press.
      if (st.foreground && text.trim()) r.fg.add(st.foreground);
      if (st.background && st.background !== defBg) r.bgOff = true;
      if (st.inverse) r.inverse = true;
    }
    const list = [...rows.values()].sort((a, b) => a.row - b.row);
    for (const r of list) {
      r.text = '';
      for (let i = 0; i < r.cells.length; i++) r.text += r.cells[i] === undefined ? ' ' : r.cells[i];
      r.trimmed = r.text.replace(/\s+$/, '');
      r.isRule = RULE_RE.test(r.trimmed);
      r.isBlank = r.trimmed.trim() === '';
      r.hasGlyph = MARKER_GLYPHS.indexOf(firstGlyph(r.trimmed)) >= 0;
      if (r.indent === null) r.indent = 0;
    }
    return { rows: list, defaultBg: defBg };
  }

  // ---- run selection ------------------------------------------------------------------------------

  // A menu renders below the input line. Start at the first substantive row after the cursor,
  // skipping the rule that Claude draws under its input box, and stop at the first blank/rule.
  function candidateRun(rows, cursorRow) {
    const after = rows.filter((r) => r.row > cursorRow);
    let i = 0;
    while (i < after.length && (after[i].isBlank || after[i].isRule)) i++;
    if (i >= after.length) return null;
    if (after[i].row - cursorRow > MAX_GAP_AFTER_CURSOR) return null;
    const run = [];
    for (; i < after.length; i++) {
      const r = after[i];
      if (r.isBlank || r.isRule) break;
      if (run.length && r.row !== run[run.length - 1].row + 1) break;   // must be contiguous
      run.push(r);
      if (run.length > MAX_RUN_ROWS) return null;
    }
    return run.length ? run : null;
  }

  // ---- items --------------------------------------------------------------------------------------

  // An item starts at the run's base indent; a row indented much deeper is that item's wrapped
  // description and belongs to it. This is what makes one arrow press equal one item (finding 2).
  function groupItems(run) {
    const baseIndent = Math.min(...run.map((r) => r.indent));
    const items = [];
    for (const r of run) {
      if (r.indent >= baseIndent + CONT_INDENT_DELTA && items.length) items[items.length - 1].rows.push(r);
      else items.push({ rows: [r] });
    }
    for (const it of items) {
      it.startRow = it.rows[0].row;
      // Whitespace-collapsed, because column padding differs between a selected and an unselected
      // rendering of the same item. The §6.1 read-back compares this text across frames, so it must
      // be stable across that difference or every verified commit would abort.
      it.text = it.rows[0].trimmed.trim().replace(/\s+/g, ' ');
      it.fg = new Set();
      for (const r of it.rows) for (const c of r.fg) it.fg.add(c);
    }
    return items;
  }

  // ---- selection signal ---------------------------------------------------------------------------

  // Marked = the ONE item carrying a foreground no other item carries. Colours shared by several
  // items (the field colour, and whatever a description uses) cannot indicate a selection, and a
  // colour appearing in two items means we cannot tell which is selected — so that is "no menu",
  // never a guess. `inverse` and background are accepted too, for TUIs that do use them, but they
  // are not what Claude does.
  function markedIndex(items) {
    const seen = new Map();
    items.forEach((it) => { for (const c of it.fg) seen.set(c, (seen.get(c) || 0) + 1); });

    // There must be a FIELD: a colour at least two unmarked items share. Without one there is no
    // "rest of the menu" to stand out from, and every row differing from every other row is just
    // ordinary coloured output.
    let field = null, fieldN = 1;
    for (const [c, n] of seen) if (n > fieldN) { fieldN = n; field = c; }
    if (!field || fieldN < 2) return null;

    const unique = [];
    items.forEach((it, i) => { for (const c of it.fg) if (seen.get(c) === 1) { unique.push(i); return; } });
    if (unique.length === 1) return { index: unique[0], signal: 'foreground' };

    const inv = items.map((it, i) => (it.rows.some((r) => r.inverse) ? i : -1)).filter((i) => i >= 0);
    if (inv.length === 1) return { index: inv[0], signal: 'inverse' };

    const bg = items.map((it, i) => (it.rows.some((r) => r.bgOff) ? i : -1)).filter((i) => i >= 0);
    if (bg.length === 1) return { index: bg[0], signal: 'background' };

    return null;
  }

  // ---- multi-column rejection -----------------------------------------------------------------------

  // zsh packs several candidates per row. Up/Down cannot reach most cells and a tapped row is
  // ambiguous about which candidate was meant, so such a run renders nothing (§6.4). Measured: zsh
  // produced two candidates per row even for 35-character names at 98 columns, so this is the
  // common case, not an edge case.
  // A wide gap alone does NOT mean multiple candidates: Claude's menu puts a prose description in a
  // second column at a fixed indent, and a naive gap test rejected its own menu outright. What
  // distinguishes a real multi-candidate row is that EVERY block on it looks like a candidate —
  // short, and containing no internal spaces (a filename, not a sentence).
  const CANDIDATE_MAX = 30;
  function rowIsMultiCandidate(text) {
    const blocks = text.trim().split(/ {3,}/).filter(Boolean);
    if (blocks.length < 2) return false;
    return blocks.every((b) => b.length <= CANDIDATE_MAX && !/\s/.test(b));
  }
  function looksMultiColumn(items) {
    let hits = 0;
    for (const it of items) if (rowIsMultiCandidate(it.rows[0].trimmed)) hits++;
    return hits >= Math.max(2, Math.ceil(items.length / 2));
  }

  /**
   * parseMenu(grid) -> null | { items:[{text,startRow}], markedIndex, signal }
   * null means "no live interactive menu here" — the safe answer, and the common one.
   */
  function parseMenu(grid) {
    if (!grid || !grid.cursor || !spansOf(grid)) return null;
    // A menu you can DRIVE requires a live input context. Caught on a real surface: `claude usage`
    // output is four rows, the first coloured differently and the rest sharing a field — it passed
    // every content rule. What it does not have is an input line: its cursor is parked at the top
    // left, `visible:false`, on an empty row. Both checks below are that difference, and they cost
    // nothing.
    if (grid.cursor.visible === false) return null;
    const { rows } = buildRows(grid);
    const cursorRow = rows.find((r) => r.row === grid.cursor.row);
    if (!cursorRow || !cursorRow.trimmed.trim()) return null;   // nothing is being typed here

    // The cursor must be sitting on an INPUT LINE — a prompt, not just any non-empty row.
    //
    // Caught in live use: while Claude renders a tool call, its bash-command box sits below the
    // cursor, and the wrapped command lines satisfied every other rule — one line coloured
    // differently against a field of dim ones, three or more rows, right below the cursor. Chips
    // appeared over the operator's own transcript.
    //
    // Both positive fixtures show what an input line actually looks like: `❯ /` and `❯ @`, with a
    // ─── rule drawn between it and the menu. Transcript content has neither. Requiring the prompt
    // glyph makes this Claude-shaped, which is honest — Claude's menus are the target, zsh's are
    // multi-column and already yield nothing, and the cost of a false positive is keystrokes in a
    // live agent session.
    if (!cursorRow.hasGlyph) return null;
    const run = candidateRun(rows, grid.cursor.row);
    if (!run) return null;

    const items = groupItems(run);
    if (items.length < MIN_ITEMS) return null;
    if (looksMultiColumn(items)) return null;
    // An item whose first row is only a marker glyph is input-box chrome, not an option (finding 3).
    if (items.some((it) => it.text === '' || (it.rows[0].hasGlyph && it.text.replace(/^[^\s]\s*/, '').trim() === ''))) return null;

    const marked = markedIndex(items);
    if (!marked) return null;

    return {
      items: items.map((it) => ({ text: it.text, startRow: it.startRow, rows: it.rows.length })),
      markedIndex: marked.index,
      signal: marked.signal,
    };
  }

  /** Arrow steps from the marked item to `targetIndex`. Empty array = already there. */
  function stepsTo(menu, targetIndex) {
    if (!menu || targetIndex < 0 || targetIndex >= menu.items.length) return null;
    const delta = targetIndex - menu.markedIndex;
    return new Array(Math.abs(delta)).fill(delta > 0 ? 'down' : 'up');
  }

  // ---- paneKind ------------------------------------------------------------------------------
  //
  // What is running in a pane. This is NOT a convenience: it decides which pane a generated git
  // command is handed to (spec §7.3.1), and a misclassification hands `git push --force` to
  // something that was not asked for. So: complete inputs, fixed precedence, and every ambiguity
  // resolving to `unknown` — which is never a permitted target.
  //
  // Inputs are exactly {grid, status}. No filesystem, no cmux calls, so it tests against fixtures.

  const AGENT_STATUS_RE = /claude|codex|agent/i;
  // Claude Code draws a boxed input: a rule, a ❯ prompt line, another rule. That signature is
  // stable across every capture, and it is what distinguishes an agent from a shell that merely
  // has "claude" somewhere in its scrollback.
  // Both return the LAST row at which the signature appears, or -1. Position is what disambiguates:
  // a live Claude session always shows a shell prompt too — the one that launched it, still in the
  // viewport above — so "both signals present" is the normal case, not the ambiguous one. What
  // matters is which came last. A boxed prompt below the shell prompt means the agent is running;
  // a shell prompt below the box means the agent exited and the shell is back.
  function lastBoxedPrompt(rows) {
    let at = -1;
    for (let i = 0; i + 2 < rows.length; i++) {
      if (rows[i].isRule && rows[i + 2].isRule && rows[i + 1].hasGlyph) at = rows[i + 1].row;
    }
    return at;
  }
  function lastShellPrompt(rows) {
    let at = -1;
    for (const r of rows) if (r.bgOff && !r.isRule && r.trimmed.trim().length > 0) at = r.row;
    return at;
  }

  function paneKind(input) {
    const grid = input && input.grid;
    const status = (input && input.status) || '';
    if (!grid || !spansOf(grid)) return { kind: "unknown", why: "no grid" };

    // Precedence 1: an explicit running-agent status wins outright — it is the strongest evidence
    // available and it does not depend on rendering.
    if (AGENT_STATUS_RE.test(status)) return { kind: 'agent', why: 'status', seq: grid.state_seq };

    if (grid.active_screen && grid.active_screen !== 'primary') {
      return { kind: 'altscreen', why: 'alternate screen', seq: grid.state_seq };
    }

    const { rows } = buildRows(grid);
    const boxed = lastBoxedPrompt(rows);
    const shell = lastShellPrompt(rows);

    // Precedence 2: grid signals, resolved by position — whichever signature appears LOWER on the
    // screen is the current one.
    if (boxed < 0 && shell < 0) return { kind: 'unknown', why: 'no decisive signal', seq: grid.state_seq };
    if (boxed === shell) return { kind: 'unknown', why: 'signals indistinguishable', seq: grid.state_seq };
    return boxed > shell
      ? { kind: 'agent', why: 'boxed prompt below shell prompt', seq: grid.state_seq }
      : { kind: 'shell', why: 'shell prompt below any agent box', seq: grid.state_seq };
  }

  return {
    parseMenu, stepsTo, paneKind, buildRows, defaultBackground,
    _internals: { candidateRun, groupItems, markedIndex, looksMultiColumn, rowIsMultiCandidate },
  };
});
