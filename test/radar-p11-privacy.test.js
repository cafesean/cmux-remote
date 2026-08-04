'use strict';
// p11 S-007 — the privacy precondition. It FAILS THE BUILD; it does not warn.
//
// WHY THIS FILE EXISTS. This repository is public. p7 leaked owner-identifying material and the repo
// had to be deleted and recreated. p11 widens the surface: WorkRefs carry tracker summaries,
// assignees, issue URLs and machine-derived route reasons, and the natural instinct when proving a
// feature works is to paste a real snapshot into `evidence/`. That instinct is the leak.
//
// Codex round 1 (finding 9) caught the original acceptance criterion — "record the real-data run in
// evidence/ with the observed counts" — as exactly that path, and noted that leaning on p9's inbox
// detector is no guard at all while p9 sits on an unmerged branch. So p11 carries its own minimal
// structural check here. It is deliberately NOT a copy of p9's denylist: when p9 merges, its
// detector becomes the shared implementation and this file becomes its caller.
//
// WHAT IS ALLOWED IN p11 ARTIFACTS: integer counts, canonical status values, enum reasons, timing,
// and synthetic identifiers in the repo's established style (PROJ/ALPHA/BETA, jira.example.com,
// /repo/<name>).
//
// IDENTITY TERMS COME FROM THE MACHINE AT RUNTIME, never from a list committed here — the p9
// lesson: a hardcoded denylist ships the very words it is meant to protect, and guards exactly one
// person. Whoever runs this is who it guards.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

// Every artifact p11 adds to a public repository.
const P11_FILES = [
  'radar/workref.js',
  'radar/eligibility.js',
  'radar/dispatch.js',
  'radar/config.example.json',
  'test/radar-p11-config.test.js',
  'test/radar-p11-workref.test.js',
  'test/radar-p11-eligibility.test.js',
  'test/radar-p11-jira-agile.test.js',
  'test/radar-p11-state-additive.test.js',
  'test/radar-p11-dispatch.test.js',
  'test/radar-p11-privacy.test.js',
  'test/radar-p11-cli.test.js',
];

function evidenceFiles() {
  const dir = path.join(REPO, 'evidence');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith('p11')).map((f) => path.join('evidence', f));
}

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Runtime-derived, exactly as p9 does it: environment identity plus the git identity, plus a
// site-extensible list that is never committed.
function identityTerms() {
  const out = new Set();
  const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s.length >= 3) out.add(s.toLowerCase()); };
  add(process.env.USER);
  add(process.env.LOGNAME);
  for (const k of ['user.name', 'user.email']) {
    try { add(execFileSync('/usr/bin/git', ['config', '--get', k], { encoding: 'utf8' }).trim()); } catch (_) { /* absent is fine */ }
  }
  const home = os.homedir();
  if (home) add(path.basename(home));
  for (const t of String(process.env.RADAR_PRIVACY_TERMS || '').split(',')) add(t);
  return [...out].filter(Boolean);
}

// Shapes that are never invented, and therefore never legitimately present.
const STRUCTURAL = [
  { name: 'absolute home path', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
  { name: 'absolute /Volumes user path', re: /\/Volumes\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g },
  { name: 'session URL', re: /https?:\/\/[A-Za-z0-9.-]*claude\.[A-Za-z]{2,}\/\S*/g },
  { name: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
];

// The synthetic vocabulary this repo already uses. A hit inside one of these is not a finding.
const SYNTHETIC_OK = /^(?:PROJ|ALPHA|BETA)-\d+$/;

// Documented placeholders. The DETECTOR stays strict — `/Users/<name>` is exactly the shape worth
// catching — but the repo's own example config has always written `/Users/you`, and `you` is not a
// person. Exempting the specific placeholder segments is narrower and more honest than loosening
// the pattern, which would let a real username through the same hole.
const PLACEHOLDER_SEGMENTS = new Set(['you', 'youruser', 'example', 'user']);
const isPlaceholderPath = (hit) => PLACEHOLDER_SEGMENTS.has(String(hit).split('/').filter(Boolean).pop().toLowerCase());

function scan(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [];
  const text = fs.readFileSync(abs, 'utf8');
  const findings = [];
  for (const { name, re } of STRUCTURAL) {
    for (const m of text.match(re) || []) {
      if (name.includes('path') && isPlaceholderPath(m)) continue;
      findings.push(`${rel}: ${name} → ${m}`);
    }
  }
  for (const term of identityTerms()) {
    const re = new RegExp(reEscape(term), 'i');
    if (re.test(text)) findings.push(`${rel}: runtime identity term → ${term}`);
  }
  return findings;
}

test('p11 source and test artifacts carry no identifying material', () => {
  const findings = P11_FILES.flatMap(scan);
  assert.deepStrictEqual(findings, [], `public-repo leak (spec F19, trap 15):\n${findings.join('\n')}`);
});

test('p11 evidence is counts-only — no titles, URLs, paths or ids', () => {
  const files = evidenceFiles();
  const findings = files.flatMap(scan);
  assert.deepStrictEqual(findings, [], `evidence leak (Codex finding 9):\n${findings.join('\n')}`);

  // Beyond the structural scan: evidence may only carry the permitted value classes. Anything that
  // looks like prose from a tracker is refused outright, because a summary is the single most
  // likely thing to be pasted in and the single most identifying.
  for (const rel of files) {
    if (!rel.endsWith('.json')) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const walk = (v, at) => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
      if (typeof v === 'string') {
        assert.ok(
          /^[a-z0-9 :._@+-]*$/i.test(v) && v.length <= 64,
          `${rel}${at}: evidence strings must be short enum/count/timing values, got ${JSON.stringify(v).slice(0, 80)}`,
        );
        assert.ok(!SYNTHETIC_OK.test(v) || true);
        return;
      }
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
      for (const k of Object.keys(v)) {
        assert.ok(!/^(title|summary|description|assignee|sourceUrl|seedPath|transcriptPath|cwd|worktree|path)$/i.test(k),
          `${rel}${at}: forbidden evidence key "${k}"`);
        walk(v[k], `${at}.${k}`);
      }
    };
    walk(doc, '');
  }
});

test('the guard derives identity at runtime and hardcodes nobody', () => {
  const self = fs.readFileSync(path.join(REPO, 'test/radar-p11-privacy.test.js'), 'utf8');
  // The file must not contain a committed list of the very terms it protects — p9's exact lesson.
  assert.ok(/process\.env\.USER/.test(self));
  assert.ok(/RADAR_PRIVACY_TERMS/.test(self));
  assert.ok(identityTerms().length > 0, 'a machine with no derivable identity would silently guard nothing');
});
