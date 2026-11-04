'use strict';
// store.js — the relay's only state: serverKey hash -> device tokens, in one JSON file.
//
// The raw serverKey is NEVER written. The file holds sha256(serverKey), so a stolen data file
// cannot be replayed against /v1/push. Writes are tmp + rename, so a crash mid-write leaves the
// previous file intact rather than half of a new one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hashKey = (serverKey) => crypto.createHash('sha256').update(String(serverKey)).digest('hex');

function createStore(file) {
  let data = { servers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.servers === 'object' && parsed.servers) data = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[relay] store unreadable (${e.message}); starting empty`);
  }

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const get = (hash) => data.servers[hash] || null;

  return {
    has: (hash) => !!get(hash),
    tokens: (hash) => (get(hash) ? get(hash).deviceTokens.map((d) => d.token) : []),
    addToken(hash, token, platform, now = Date.now()) {
      const rec = data.servers[hash] || (data.servers[hash] = { deviceTokens: [] });
      if (!rec.deviceTokens.some((d) => d.token === token)) {
        rec.deviceTokens.push({ token, platform, addedAt: new Date(now).toISOString() });
      }
      save();
    },
    removeToken(hash, token) {
      const rec = get(hash);
      if (!rec) return;
      rec.deviceTokens = rec.deviceTokens.filter((d) => d.token !== token);
      save();
    },
  };
}

module.exports = { createStore, hashKey };
