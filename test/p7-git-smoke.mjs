// p7 Track C — browser proof of the source-control panel against a REAL seeded repo.
//
// The repo is seeded with actual dirt (staged, unstaged, untracked, a rename) because a clean repo
// passes every assertion here vacuously — the same shape as the paging test that once passed
// because the directory was smaller than one page.
//
// The safety property under test is the important half: stage/unstage act on the real index, and
// nothing destructive can run from the panel — it fills a composer and stops.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PW = process.env.PLAYWRIGHT_DIR || '/path/to/workspace/app-web/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const exec = promisify(execFile);
const CMUX = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const BASE = process.env.P7_BASE || 'http://127.0.0.1:8091';
const TOKEN = process.env.SERVER_TOKEN;
if (!TOKEN) { console.error('SERVER_TOKEN required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmux = async (a) => (await exec(CMUX, a, { maxBuffer: 32 << 20 })).stdout;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

let repo = null, scratchWs = null;
async function cleanup() {
  if (scratchWs) { try { await cmux(['close-workspace', '--workspace', scratchWs]); } catch (_) {} scratchWs = null; }
  if (repo) { try { await rm(repo, { recursive: true, force: true }); } catch (_) {} repo = null; }
}

async function seedRepo() {
  repo = await mkdtemp(path.join(tmpdir(), 'p7-repo-'));
  const g = (...a) => exec('/usr/bin/git', ['-C', repo, ...a]);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'T');
  await writeFile(path.join(repo, 'kept.txt'), 'one\n');
  await writeFile(path.join(repo, 'renamed-from.txt'), 'move me\n');
  await g('add', '.'); await g('commit', '-qm', 'first');
  // real dirt of every kind the panel groups
  await writeFile(path.join(repo, 'kept.txt'), 'one\ntwo\n');          // unstaged modify
  await writeFile(path.join(repo, 'staged.txt'), 'staged\n');
  await g('add', 'staged.txt');                                        // staged add
  await writeFile(path.join(repo, 'untracked.txt'), 'new\n');          // untracked
  await g('mv', 'renamed-from.txt', 'renamed-to.txt');                 // rename
  return repo;
}

async function main() {
  await seedRepo();

  // A workspace whose cwd IS the seeded repo — that is how the panel discovers repos.
  const before = new Set(JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both'])).windows
    .flatMap((w) => w.workspaces).map((w) => w.id));
  await cmux(['new-workspace', '--focus', 'false', '--cwd', repo]);
  await sleep(2000);
  const t = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
  const created = t.windows.flatMap((w) => w.workspaces).find((w) => !before.has(w.id));
  if (!created) throw new Error('scratch workspace did not appear');
  scratchWs = created.id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });
  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  ok(await page.locator('#gitBtn').count() === 1, 'the source-control chip is present');
  await page.click('#gitBtn');
  await page.waitForSelector('#gitpanel.on', { timeout: 8000 });

  // ---- repo list ----
  await page.waitForSelector('#gitpanel .grow button', { timeout: 15000 });
  const repoNames = await page.locator('#gitpanel .grow button').allTextContents();
  const mine = path.basename(repo);
  ok(repoNames.includes(mine), `the seeded repo is discovered from the workspace cwd (${mine})`);
  await page.locator('#gitpanel .grow button', { hasText: mine }).first().click();
  await page.waitForSelector('#gitpanel .ghead', { timeout: 15000 });

  // ---- changes, grouped, with real dirt ----
  const heads = (await page.locator('#gitpanel .ghead').allTextContents()).join(' | ');
  ok(/Staged/.test(heads), `staged group present (${heads})`);
  ok(/Changes/.test(heads), 'unstaged group present');
  ok(/Untracked/.test(heads), 'untracked group present');
  const rows = (await page.locator('#gitpanel .grow').allTextContents()).join(' ');
  ok(/renamed-from\.txt\s*→\s*renamed-to\.txt/.test(rows.replace(/\s+/g, ' ')), 'a rename shows both paths');

  // ---- stage acts on the REAL index ----
  const stageBtn = page.locator('#gitpanel .grow', { hasText: 'untracked.txt' }).locator('.gact').first();
  await stageBtn.click();
  await sleep(2500);
  const { stdout: idx } = await exec('/usr/bin/git', ['-C', repo, 'diff', '--cached', '--name-only']);
  ok(idx.includes('untracked.txt'), 'tapping stage put the file in the real git index');

  const unstageBtn = page.locator('#gitpanel .grow', { hasText: 'untracked.txt' }).locator('.gact').first();
  await unstageBtn.click();
  await sleep(2500);
  const { stdout: idx2 } = await exec('/usr/bin/git', ['-C', repo, 'diff', '--cached', '--name-only']);
  ok(!idx2.includes('untracked.txt'), 'tapping unstage removed it again');

  // ---- diff ----
  await page.locator('#gitpanel .grow button', { hasText: 'kept.txt' }).first().click();
  await page.waitForSelector('#gitpanel .gdiff', { timeout: 10000 });
  const diff = await page.locator('#gitpanel .gdiff').textContent();
  ok(/\+two/.test(diff), 'the diff shows the real change');

  // ---- branches ----
  await page.locator('#gitpanel .gseg', { hasText: 'Branches' }).click();
  await sleep(2500);
  const branches = (await page.locator('#gitpanel .grow button').allTextContents()).join(' ');
  ok(/main/.test(branches), 'branches list the real branch');
  ok(/↑1/.test(branches), 'unpushed count is reported by the shared definition');

  // ---- worktrees ----
  await page.locator('#gitpanel .gseg', { hasText: 'Worktrees' }).click();
  await sleep(2500);
  const wts = (await page.locator('#gitpanel .grow button').allTextContents()).join(' ');
  ok(/main/.test(wts), 'the worktree list includes the checkout');

  // ---- the safety property: a destructive verb FILLS, never runs ----
  await page.locator('#gitpanel .gseg', { hasText: 'Changes' }).click();
  await sleep(2000);
  const headBefore = (await exec('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await page.locator('#gitpanel .gcmd', { hasText: 'Commit' }).click();
  await sleep(2500);
  const composed = await page.inputValue('#text');
  ok(/^git commit -m/.test(composed.trim()), `the command landed in the composer unsent (${composed.trim()})`);
  const headAfter = (await exec('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  ok(headBefore === headAfter, 'NOTHING was committed — the panel fills a box, it does not run git');

  await page.screenshot({ path: '/tmp/p7-git.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
