'use strict';
// Hook-receiver identity capture. The receiver runs INSIDE each Claude session, so the tab it is
// hosted by is simply in its environment — these lock that it is read, and that its absence is
// recorded as absence rather than guessed at.
const { test } = require('node:test');
const assert = require('node:assert');

// ── cmux identity capture (hook-receiver reads its OWN env) ──────────────────────────────────────
{
  const receiver = require('../radar/hook-receiver');

  test('cmuxIdentity reads the ids cmux exports into every process it launches', () => {
    const got = receiver.cmuxIdentity({
      CMUX_SURFACE_ID: 'S-1', CMUX_TAB_ID: 'T-1', CMUX_WORKSPACE_ID: 'W-1',
    });
    assert.deepStrictEqual(got, { surfaceId: 'S-1', tabId: 'T-1', workspaceId: 'W-1' });
  });

  test('a session started outside cmux records absence, never a fabricated id', () => {
    assert.deepStrictEqual(receiver.cmuxIdentity({}), { surfaceId: '', tabId: '', workspaceId: '' });
    assert.deepStrictEqual(receiver.cmuxIdentity({ CMUX_SURFACE_ID: '   ' }).surfaceId, '');
  });

  test('the older SUPACODE_* names still resolve, and CMUX_PANEL_ID is the last resort', () => {
    assert.strictEqual(receiver.cmuxIdentity({ SUPACODE_SURFACE_ID: 'S-9' }).surfaceId, 'S-9');
    assert.strictEqual(receiver.cmuxIdentity({ CMUX_PANEL_ID: 'P-9' }).surfaceId, 'P-9');
    // A real CMUX_SURFACE_ID always beats the fallbacks.
    assert.strictEqual(receiver.cmuxIdentity({ CMUX_SURFACE_ID: 'S-1', CMUX_PANEL_ID: 'P-9' }).surfaceId, 'S-1');
  });
}
