'use strict';
// Cloudflare Access service-token helper, shared by server.js and the radar. A machine/bridge row names
// the ENV VARS holding the token (accessIdEnv / accessSecretEnv) so no value sits in a config file;
// raw accessId / accessSecret still work. The env-var name wins if both are given.
// Never log a value: warnings and startup lines carry the VAR NAME only.
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// -> { id, secret, problems: [string] } ; id/secret '' when unresolved. problems name vars only.
function inspect(row, env) {
  const r = row || {};
  const e = env || process.env;
  const problems = [];
  const pick = (nameKey, rawKey) => {
    const name = r[nameKey];
    if (name !== undefined && name !== null && name !== '') {
      if (typeof name !== 'string' || !NAME_RE.test(name)) { problems.push(`${nameKey}: invalid env var name`); return ''; }
      const v = e[name];
      if (!v) { problems.push(`missing ${name}`); return ''; }
      return String(v);
    }
    return typeof r[rawKey] === 'string' ? r[rawKey] : '';
  };
  return { id: pick('accessIdEnv', 'accessId'), secret: pick('accessSecretEnv', 'accessSecret'), problems };
}

function resolveAccess(row, env) {
  const { id, secret } = inspect(row, env);
  return id && secret ? { id, secret } : null;
}

function headersFor(access) {
  return access ? { 'CF-Access-Client-Id': access.id, 'CF-Access-Client-Secret': access.secret } : {};
}

// Headers for a row; none for unix: socket rows (socketPath set or baseUrl unix:).
function accessHeadersFor(row, env) {
  if (!row || row.socketPath || /^unix:/.test(String(row.baseUrl || ''))) return {};
  return headersFor(resolveAccess(row, env));
}

// Startup label: '' | ' [CF Access]' | ' [CF Access: missing CMUX_X]'. Names only.
function statusLabel(row, env) {
  const r = row || {};
  const { problems } = inspect(r, env);
  if (problems.length) return ` [CF Access: ${problems.join(', ')}]`;
  return resolveAccess(r, env) ? ' [CF Access]' : '';
}

module.exports = { NAME_RE, resolveAccess, headersFor, accessHeadersFor, statusLabel };
