'use strict';
// lib/raw-get.js: the raw-socket GET the download relay uses under Bun (node:http's client there reads a
// body ahead without bound). Framing (content-length, chunked, EOF), a paused body that stops reading
// the socket, header injection refused, abort before and after the head.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { rawGet } = require('../lib/raw-get');

// A server that answers every connection with the given raw bytes (or calls fn(socket, head)).
function rawServer(fn) {
  return new Promise((resolve) => {
    const seen = [];
    const s = net.createServer((c) => {
      let head = '';
      c.on('data', (d) => {
        head += d;
        if (!head.includes('\r\n\r\n')) return;
        seen.push(head);
        if (typeof fn === 'string' || Buffer.isBuffer(fn)) c.end(fn); else fn(c, head);
      });
      c.on('error', () => {});
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: 'http://127.0.0.1:' + s.address().port + '/p?q=1' }));
  });
}
async function readBody(r) { const out = []; for await (const c of r) out.push(c); return Buffer.concat(out).toString(); }

test('content-length body, request line and headers', async () => {
  const { s, seen, url } = await rawServer('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhelloEXTRA');
  try {
    const r = await rawGet({ url }, '/ignored', { headers: { 'x-bridge-secret': 's1', range: 'bytes=0-' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'text/plain');
    assert.equal(await readBody(r), 'hello');
    assert.match(seen[0], /^GET \/p\?q=1 HTTP\/1\.1\r\n/);
    assert.match(seen[0], /\r\nx-bridge-secret: s1\r\n/);
    assert.match(seen[0], /\r\nconnection: close\r\n/);
  } finally { s.close(); }
});

test('chunked body with extensions and trailers', async () => {
  const { s, url } = await rawServer('HTTP/1.1 206 Partial\r\nTransfer-Encoding: chunked\r\n\r\n3;x=1\r\nabc\r\n4\r\ndefg\r\n0\r\nT: 1\r\n\r\n');
  try {
    const r = await rawGet({ url }, '/', {});
    assert.equal(r.statusCode, 206);
    assert.equal(await readBody(r), 'abcdefg');
  } finally { s.close(); }
});

test('body until EOF when there is no framing', async () => {
  const { s, url } = await rawServer('HTTP/1.1 200 OK\r\n\r\nall of it');
  try { assert.equal(await readBody(await rawGet({ url }, '/', {})), 'all of it'); } finally { s.close(); }
});

test('a short content-length body errors', async () => {
  const { s, url } = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort');
  try { await assert.rejects(readBody(await rawGet({ url }, '/', {}))); } finally { s.close(); }
});

test('a header with CR/LF is refused before anything is sent', async () => {
  const { s, seen, url } = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  try {
    await assert.rejects(rawGet({ url }, '/', { headers: { range: 'bytes=0-\r\nx-evil: 1' } }), /bad header/);
    assert.equal(seen.length, 0);
  } finally { s.close(); }
});

test('abort before the head rejects; after it the body errors', async () => {
  const { s, url } = await rawServer((c, head) => { if (head.includes('late')) c.write('HTTP/1.1 200 OK\r\n\r\npart'); });
  try {
    const c1 = new AbortController();
    const p = rawGet({ url }, '/', { signal: c1.signal });
    setTimeout(() => c1.abort(), 50);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    const c2 = new AbortController();
    const r = await rawGet({ url }, '/', { signal: c2.signal, headers: { 'x-t': 'late' } });
    setTimeout(() => c2.abort(), 50);
    await assert.rejects(readBody(r), (e) => e.name === 'AbortError');
  } finally { s.close(); }
});

test('a paused body stops reading the socket (backpressure reaches the sender)', async () => {
  const BIG = 32 * 1024 * 1024;
  let written = 0, stalled = false;
  const { s, url } = await rawServer((c) => {
    c.write('HTTP/1.1 200 OK\r\nContent-Length: ' + BIG + '\r\n\r\n');
    const chunk = Buffer.alloc(64 * 1024, 1);
    const pump = () => { while (written < BIG) { written += chunk.length; if (!c.write(chunk)) { stalled = true; return c.once('drain', pump); } } c.end(); };
    pump();
  });
  try {
    const r = await rawGet({ url }, '/', {});
    r.pause();
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(stalled, 'sender never saw backpressure');
    assert.ok(written < 16 * 1024 * 1024, 'sender wrote ' + written + ' bytes into a paused reader');
    let n = 0; for await (const c of r) n += c.length;
    assert.equal(n, BIG);
  } finally { s.close(); }
});
