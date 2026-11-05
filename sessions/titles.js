'use strict';
// p41 A11 — session title choice. A cmux tab title is the terminal's process title ("cswap", "zsh",
// "user@host:~/x"): it changes with the wrapper or Claude account and is not an identity. Priority:
//   1 transcript custom-title   2 tmux session name (stable)   3 workspace title + short surface ref
//   4 tab.title, only when it is not a volatile process/shell/prompt title
// Non-agent terminals prefer the tab title (preferTab) so a plain `vim x` pane keeps its own title.
// One config object, no inline lists (LIMITS.md row: titleMax).
const TITLES = {
  titleMax: 120,
  volatileNames: ['cswap', 'claude', 'claude-code', 'node', 'nodejs', 'bun', 'deno', 'npx', 'tsx', 'uv', 'tmux', 'zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'login'],
  volatilePatterns: [/^python[\d.]*$/i, /^\S+@\S+:.*$/, /^-?(zsh|bash|sh|fish)\b/i],
  unnamedTmux: /^\d+$/,        // tmux's default session names (0, 1, ...) are not a name
};

function isVolatileTitle(t, cfg) {
  const c = cfg || TITLES;
  const s = String(t == null ? '' : t).trim();
  if (!s) return true;
  const word = s.split(/\s+/)[0].replace(/^.*[\\/]/, '').toLowerCase();
  if (c.volatileNames.includes(word)) return true;
  return c.volatilePatterns.some((re) => re.test(s) || re.test(word));
}

function pickTitle(o, cfg) {
  const c = cfg || TITLES;
  const clip = (s) => String(s).trim().slice(0, c.titleMax);
  const custom = o.customTitle && String(o.customTitle).trim();
  if (custom) return clip(custom);
  const tmux = o.tmuxName && String(o.tmuxName).trim();
  if (tmux && !c.unnamedTmux.test(tmux)) return clip(tmux);
  const tabOk = o.tabTitle && !isVolatileTitle(o.tabTitle, c);
  if (o.preferTab && tabOk) return clip(o.tabTitle);
  const ref = o.surfaceRef || o.surface;
  if (o.workspaceTitle) return clip(ref ? `${o.workspaceTitle} ${ref}` : o.workspaceTitle);
  if (tabOk) return clip(o.tabTitle);
  return clip(ref || o.surface || '');
}

module.exports = { pickTitle, isVolatileTitle, TITLES };
