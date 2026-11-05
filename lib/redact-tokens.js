'use strict';
// S2r: a Claude/Anthropic token never leaves the Mac in a bridge reply. A session started on a named
// account has CLAUDE_CODE_OAUTH_TOKEN in its env, so `env` in a tool call, a pasted key or a printed
// config can put one into a transcript or onto the terminal screen. Every text the bridge sends out
// (JSON replies and SSE events) passes through here first.
// Shape: sk-ant-<kind><version?>-<body>, e.g. sk-ant-oat01-…, sk-ant-api03-…, sk-ant-admin01-…
// Token characters are [A-Za-z0-9_-], which JSON never escapes, so this works on serialized JSON too.
const TOKEN_RE = /sk-ant-[a-z]+\d*-[A-Za-z0-9_-]{8,}/g;
const MASK = 'sk-ant-…[redacted]';

function redactTokens(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.includes('sk-ant-') ? s.replace(TOKEN_RE, MASK) : s;
}

module.exports = { redactTokens, MASK };
