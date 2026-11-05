'use strict';
// Detects Claude settings that would override a named account's CLAUDE_CODE_OAUTH_TOKEN
// (apiKeyHelper, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN). Returns file+key only, never a value.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MANAGED = '/Library/Application Support/ClaudeCode/managed-settings.json';
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

function findOverride({ cwd, home, managedPath } = {}) {
  const files = [
    managedPath || DEFAULT_MANAGED,
    path.join(home || os.homedir(), '.claude', 'settings.json'),
    path.join(cwd || process.cwd(), '.claude', 'settings.json'),
    path.join(cwd || process.cwd(), '.claude', 'settings.local.json'),
  ];
  for (const file of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!s || typeof s !== 'object') continue;
    if (nonEmpty(s.apiKeyHelper)) return { file, key: 'apiKeyHelper' };
    const env = s.env && typeof s.env === 'object' ? s.env : {};
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (nonEmpty(env[k])) return { file, key: `env.${k}` };
    }
  }
  return null;
}

module.exports = { findOverride };

if (require.main === module) {
  const i = process.argv.indexOf('--cwd');
  const cwd = i > 0 ? process.argv[i + 1] : process.cwd();
  const hit = findOverride({ cwd, home: os.homedir(), managedPath: process.env.HYPERMUX_MANAGED_SETTINGS });
  if (hit) { process.stdout.write(`${hit.file}\t${hit.key}\n`); process.exit(4); }
}
