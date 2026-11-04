'use strict';
// p41 B2: the built-in QR encoder (lib/qr.js). Zero dependencies, byte mode, ECC L or M, versions 1-10.
// Checked three ways: the Reed-Solomon step against a published vector (thonky.com's "HELLO WORLD"
// 1-M worked example), the fixed structures a scanner locks onto, and, where zbarimg is installed,
// a real decode of the rendered symbol.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const qr = require('../lib/qr');

const BASE_120 = 'cmuxremote://pair?u=' + encodeURIComponent('https://cmux-max.cafesean.com') + '&c=K7M2QX9P&n=';
const URL_120 = BASE_120 + '-'.repeat(120 - BASE_120.length);

test('Reed-Solomon matches the published HELLO WORLD 1-M vector', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepStrictEqual(qr._reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

// A finder pattern is a 7x7 ring of dark, a 5x5 ring of light, a 3x3 dark core.
function assertFinder(m, top, left) {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    assert.strictEqual(m[top + y][left + x], d !== 2, `finder at ${top},${left} module ${x},${y}`);
  }
}

// Golden matrix for byte-mode 'hello world' at M, taken from the independent `qrcode` npm package
// (mask 2, version 1). A match means the codeword layout, masks and format bits all agree with it.
const GOLDEN_HELLO_M = [
  '#######..#.##.#######',
  '#.....#...#...#.....#',
  '#.###.#.####..#.###.#',
  '#.###.#.###.#.#.###.#',
  '#.###.#.#.#.#.#.###.#',
  '#.....#.#..#..#.....#',
  '#######.#.#.#.#######',
  '........#.#..........',
  '#.#####..#.#..#####..',
  '.##.##.#.#.########.#',
  '#.#.####.##.###..###.',
  '#.#..#...#.###..###..',
  '...#.#####..###.....#',
  '........#.#.#...##..#',
  '#######....#..#...##.',
  '#.....#.#....#.#.####',
  '#.###.#.#..#..##....#',
  '#.###.#.##..######...',
  '#.###.#.##..#..#..#..',
  '#.....#..##.##..###..',
  '#######.##.##.#.#..#.',
];

test('matches an independent encoder cell for cell on a byte-mode input', () => {
  const r = qr.encode('hello world', { ecc: 'M' });
  assert.deepStrictEqual(r.modules.map((row) => row.map((d) => (d ? '#' : '.')).join('')), GOLDEN_HELLO_M);
});

test('short input is version 1 at 21x21 with three finder patterns', () => {
  const r = qr.encode('HELLO WORLD', { ecc: 'M' });
  assert.strictEqual(r.version, 1);
  assert.strictEqual(r.size, 21);
  assert.strictEqual(r.modules.length, 21);
  assert.ok(r.modules.every((row) => row.length === 21));
  assertFinder(r.modules, 0, 0);
  assertFinder(r.modules, 0, 14);
  assertFinder(r.modules, 14, 0);
});

test('a ~120-char pair link picks version 7 at ECC M (45x45), with timing and dark module', () => {
  assert.strictEqual(URL_120.length, 120);
  const r = qr.encode(URL_120, { ecc: 'M' });
  assert.strictEqual(r.version, 7);
  assert.strictEqual(r.size, 45);
  assertFinder(r.modules, 0, 0);
  assertFinder(r.modules, 0, 38);
  assertFinder(r.modules, 38, 0);
  for (let i = 8; i < 37; i++) {
    assert.strictEqual(r.modules[6][i], i % 2 === 0, `timing row ${i}`);
    assert.strictEqual(r.modules[i][6], i % 2 === 0, `timing col ${i}`);
  }
  assert.strictEqual(r.modules[45 - 8][8], true, 'the always-dark module');
  // version 7 carries 18 version-info bits; the two copies are transposes of each other
  for (let i = 0; i < 18; i++) {
    const a = 45 - 11 + (i % 3); const b = Math.floor(i / 3);
    assert.strictEqual(r.modules[b][a], r.modules[a][b], `version info bit ${i}`);
  }
});

test('ECC L fits the same input in a smaller symbol than ECC M', () => {
  const l = qr.encode(URL_120, { ecc: 'L' });
  const m = qr.encode(URL_120, { ecc: 'M' });
  assert.strictEqual(l.version, 6);
  assert.ok(l.size < m.size);
});

test('format info is written twice and the two copies agree', () => {
  const { modules: m, size } = qr.encode(URL_120, { ecc: 'M' });
  const a = []; const b = [];
  for (let i = 0; i <= 5; i++) a.push(m[i][8]);
  a.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) a.push(m[8][14 - i]);
  for (let i = 0; i < 8; i++) b.push(m[8][size - 1 - i]);
  for (let i = 8; i < 15; i++) b.push(m[size - 15 + i][8]);
  assert.deepStrictEqual(a, b);
});

test('input past the version 10 capacity throws', () => {
  assert.throws(() => qr.encode('x'.repeat(272), { ecc: 'L' }), /too long/);
  assert.throws(() => qr.encode('x'.repeat(214), { ecc: 'M' }), /too long/);
  assert.strictEqual(qr.encode('x'.repeat(271), { ecc: 'L' }).version, 10);
});

test('toTerminal draws two module rows per text row with a quiet zone', () => {
  const r = qr.encode('HELLO WORLD', { ecc: 'M' });
  const lines = qr.toTerminal(r, { quiet: 2 }).split('\n');
  assert.strictEqual(lines.length, Math.ceil((21 + 4) / 2));
  assert.ok(lines.every((l) => [...l].length === 21 + 4));
  assert.ok(/^█+$/.test(lines[0]), 'the top quiet zone is solid light');
});

const zbar = spawnSync('zbarimg', ['--version']);
test('a real decoder reads the rendered symbol back', { skip: zbar.error ? 'zbarimg not installed' : false }, () => {
  for (const [text, ecc] of [['HELLO WORLD', 'M'], [URL_120, 'M'], [URL_120, 'L']]) {
    const r = qr.encode(text, { ecc });
    const scale = 8; const quiet = 4; const n = (r.size + quiet * 2) * scale;
    const rows = [];
    for (let y = 0; y < n; y++) {
      const my = Math.floor(y / scale) - quiet;
      let row = '';
      for (let x = 0; x < n; x++) {
        const mx = Math.floor(x / scale) - quiet;
        row += (my >= 0 && mx >= 0 && my < r.size && mx < r.size && r.modules[my][mx]) ? '1 ' : '0 ';
      }
      rows.push(row);
    }
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qr-')), 'q.pbm');
    fs.writeFileSync(f, `P1\n${n} ${n}\n${rows.join('\n')}\n`);
    const out = spawnSync('zbarimg', ['--quiet', '--raw', f], { encoding: 'utf8' });
    assert.strictEqual(out.stdout.replace(/\n$/, ''), text, `ecc ${ecc}, ${text.length} chars: ${out.stderr}`);
  }
});
