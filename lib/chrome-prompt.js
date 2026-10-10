'use strict';
// chrome-prompt.js — p27. Chrome asks "Allow remote debugging?" when an outside app (a CDP client such
// as browser-use) connects to a Chrome profile. It is a native dialog on the Mac, so from a phone there
// was no way to answer it. This finds that dialog through macOS Accessibility (System Events, JXA) and
// presses one of its buttons.
//
// SECURITY: Allow hands the connecting app full control of that Chrome profile — every logged-in site.
// The owner chose to have this button (2026-10-10) after that warning. The bridge only ever presses a
// button on a Chrome dialog whose text mentions remote debugging; it never types, never touches any
// other window, and the action is behind the bridge secret + SERVER_TOKEN like every other control.
//
// Needs Accessibility permission for the process that runs osascript (System Settings → Privacy &
// Security → Accessibility). Without it, `find` answers { error: 'no_accessibility' }.
const { execFile } = require('child_process');

// argv[0] = 'find' | 'allow' | 'deny'. Prints one JSON line.
const JXA = `
function run(argv) {
  const action = argv[0] || 'find';
  const prefix = argv[1] || 'Google Chrome';
  const se = Application('System Events');
  const procs = se.processes.whose({ name: { _beginsWith: prefix } })();
  const textOf = (el) => { const out = []; for (const k of ['value', 'title', 'description', 'name']) { try { const v = el[k](); if (v && typeof v === 'string') out.push(v); } catch (e) {} } return out.join(' '); };
  for (const p of procs) {
    let wins = [];
    try { wins = p.windows(); } catch (e) { return JSON.stringify({ error: 'no_accessibility', detail: String(e) }); }
    for (const w of wins) {
      let title = ''; try { title = w.title() || ''; } catch (e) {}
      // Browser windows are titled "<page> - Google Chrome…" and hold the whole web page; only scan
      // the small untitled/dialog windows and the sheets of browser windows.
      const candidates = [];
      if (!/ - Google Chrome/.test(title)) candidates.push(w);
      try { for (const sh of w.sheets()) candidates.push(sh); } catch (e) {}
      for (const c of candidates) {
        let els = [];
        try { els = c.entireContents(); } catch (e) { continue; }
        if (els.length > 400) continue;
        let text = textOf(c); const buttons = [];
        for (const el of els) {
          let role = ''; try { role = el.role(); } catch (e) {}
          const t = textOf(el);
          if (role === 'AXButton') {
            let label = ''; for (const k of ['name', 'title', 'description']) { try { const v = el[k](); if (v && typeof v === 'string') { label = v; break; } } catch (e) {} }
            if (!/^(close|full ?screen|minimi[sz]e|zoom) button$/i.test(label)) buttons.push({ el, name: label.trim() });
          }
          else if (t) text += ' ' + t;
        }
        if (!/remote debugging/i.test(text)) continue;
        const info = { present: true, app: p.name(), text: text.replace(/\\s+/g, ' ').trim().slice(0, 400), buttons: buttons.map((b) => b.name) };
        if (action === 'find') return JSON.stringify(info);
        const want = action === 'allow' ? /^allow\\b/i : /^(cancel|deny|don.?t allow|block|no)\\b/i;
        const b = buttons.find((x) => want.test(x.name));
        if (!b) return JSON.stringify(Object.assign(info, { error: 'no_button' }));
        // AXPress first (Chrome's own buttons honour it); if the dialog is still up, a real mouse click
        // at the button's centre — some toolkits ignore AXPress.
        let via = 'axpress';
        try { b.el.actions.byName('AXPress').perform(); } catch (e) {}
        delay(0.4);
        let still = false; try { b.el.role(); still = true; } catch (e) {}
        if (still) {
          const pos = b.el.position(), size = b.el.size();
          const x = pos[0] + size[0] / 2, y = pos[1] + size[1] / 2;
          ObjC.import('CoreGraphics');
          const pt = $.CGPointMake(x, y);
          for (const t of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
            $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), t, pt, $.kCGMouseButtonLeft));
            delay(0.05);
          }
          via = 'mouse';
        }
        return JSON.stringify(Object.assign(info, { clicked: b.name, via }));
      }
    }
  }
  return JSON.stringify({ present: false });
}`;

// `app` is the process-name prefix to search; tests point it at a stand-in dialog.
function chromePrompt(action = 'find', { app = process.env.CHROME_PROMPT_APP || 'Google Chrome', timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, action, app], { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        return resolve({ present: false, error: /not allowed|assistive|-1719|-25211|1002/i.test(msg) ? 'no_accessibility' : 'osascript_failed', detail: msg.slice(0, 200) });
      }
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch (_) { resolve({ present: false, error: 'bad_output' }); }
    });
  });
}

module.exports = { chromePrompt };
