'use strict';
// qr.js — a QR Code encoder with no dependencies (p41 pairing). Byte mode only, error correction
// L or M, versions 1-10: a pairing link is ~120 characters, which is version 7 at M. Anything that
// needs more than version 10 throws rather than quietly growing a table nobody tested.
//
// The shape follows ISO/IEC 18004: pick the smallest version that fits, build data + Reed-Solomon
// codewords, interleave the blocks, place them around the fixed patterns, then choose the mask with
// the lowest penalty. test/p41-qr.test.js checks the Reed-Solomon step against a published vector
// and decodes the rendered symbol with zbarimg when that is installed.

const MAX_VERSION = 10;

// Index = version (0 unused). Error-correction codewords per block, and number of blocks.
const ECC = {
  L: { fmt: 1, cw: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18], blocks: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4] },
  M: { fmt: 0, cw: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] },
};

// Modules in the symbol that can hold data or error correction (everything but the fixed patterns).
function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver, ecc) => Math.floor(rawModules(ver) / 8) - ECC[ecc].cw[ver] * ECC[ecc].blocks[ver];

// ---- Reed-Solomon over GF(256), polynomial 0x11D ---------------------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function reedSolomon(data, eccLen) {
  const divisor = rsDivisor(eccLen);
  const result = new Array(eccLen).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---- codewords -------------------------------------------------------------------------------
function dataBits(bytes, ver, ecc) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);                               // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, cap - bits.length));       // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return out;
}

// Split into blocks, append each block's error correction, then interleave.
function interleave(data, ver, ecc) {
  const eccLen = ECC[ecc].cw[ver];
  const nb = ECC[ecc].blocks[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const e = reedSolomon(dat, eccLen);
    if (i < numShort) dat.push(0);              // placeholder so every block indexes alike
    blocks.push(dat.concat(e));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]); });
  }
  return out;
}

// ---- the matrix ------------------------------------------------------------------------------
function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const res = [6];
  for (let pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

const bit = (v, i) => ((v >>> i) & 1) !== 0;

function buildFunctionPatterns(ver) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }   // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {                        // finders + separators
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignPositions(ver);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit(bits, i)); set(b, a, bit(bits, i));
    }
  }
  drawFormat(set, size, ECC.L.fmt, 0);         // reserve the cells; the real bits go in per mask
  return { size, modules, fn };
}

function drawFormat(set, size, eccFmt, mask) {
  const data = (eccFmt << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);                       // the always-dark module
}

function placeCodewords(m, codewords) {
  const { size, modules, fn } = m;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && i < codewords.length * 8) { modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

// Lower is better: long runs, 2x2 blocks, finder-like patterns, and dark/light imbalance.
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [];
  for (let a = 0; a < size; a++) {
    lines.push(modules[a].map(Number).join(''));
    lines.push(modules.map((row) => Number(row[a])).join(''));
  }
  for (const s of lines) {
    for (const run of s.match(/0+|1+/g)) if (run.length >= 5) score += run.length - 2;
    for (const pat of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(pat); i !== -1; i = s.indexOf(pat, i + 1)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// encode(text, { ecc: 'L' | 'M', mask?: 0-7 }) -> { version, ecc, size, modules }; modules[row][col] is true when dark.
function encode(text, opts) {
  const ecc = (opts && opts.ecc) || 'M';
  const forced = opts && opts.mask;           // 0-7 pins the mask (tests); otherwise the lowest penalty wins
  if (!ECC[ecc]) throw new Error(`qr: unsupported ecc level ${ecc} (L or M)`);
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let ver = 1;
  const fits = (v) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v, ecc) * 8;
  while (ver <= MAX_VERSION && !fits(ver)) ver++;
  if (ver > MAX_VERSION) throw new Error(`qr: input too long (${bytes.length} bytes; version ${MAX_VERSION} at ECC ${ecc} holds fewer)`);

  const codewords = interleave(dataBits(bytes, ver, ecc), ver, ecc);
  const base = buildFunctionPatterns(ver);
  placeCodewords(base, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forced !== undefined && mask !== forced) continue;
    const modules = base.modules.map((row) => row.slice());
    for (let y = 0; y < base.size; y++) for (let x = 0; x < base.size; x++) {
      if (!base.fn[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
    drawFormat((x, y, dark) => { modules[y][x] = dark; }, base.size, ECC[ecc].fmt, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { score, modules };
  }
  return { version: ver, ecc, size: base.size, modules: best.modules };
}

// Two module rows per text row using half blocks. Light modules are drawn as lit blocks, so the
// symbol reads dark-on-light on a dark terminal, which is what a phone camera expects.
function toTerminal(qr, opts) {
  const quiet = opts && opts.quiet !== undefined ? opts.quiet : 4;
  const n = qr.size + quiet * 2;
  const light = (x, y) => {
    const mx = x - quiet; const my = y - quiet;
    return !(mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx]);
  };
  const rows = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = light(x, y); const bottom = y + 1 < n ? light(x, y + 1) : true;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

module.exports = { encode, toTerminal, _reedSolomon: reedSolomon };
