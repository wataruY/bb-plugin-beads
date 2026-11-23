---
name: bb-ui-debug
description: "Drive and screenshot the BB desktop UI (e.g. the Beads issues side panel) from a thread via bb browser + raw CDP, to debug plugin UI. Use when asked to test, click through, or visually verify a BB plugin panel."
---

# BB UI debugging (bb browser + raw CDP)

Automates the BB web UI (`http://127.0.0.1:38886`) inside a BB desktop browser
tab, so plugin panels like **Beads issues** can be clicked and screenshotted.

**Do not use Playwright `connectOverCDP`** — it crashes on bb's `type: "tab"`
CDP target (assertion in `crBrowser._onAttachedToTarget`). Use raw CDP
(`scripts/bb-cdp.mjs`, Node ≥22 built-in `WebSocket`, no deps).

Requires a connected BB desktop window (`bb browser instances`).

## Workflow

1. Rebuild first if plugin code changed: `bb plugin build && bb plugin reload beads`.
2. Start a session (tab + lease; CDP info stays in private `/tmp/bb-ui-debug/`):
   `bash skills/bb-ui-debug/scripts/session.sh start`
   Never print `cdp.json` (it holds a secret WebSocket endpoint).
3. Write a throwaway script (outside the repo, e.g. `/tmp/bb-ui-debug/x.mjs`):
   ```js
   import {open} from '/abs/path/skills/bb-ui-debug/scripts/bb-cdp.mjs';
   const b = await open();
   await b.click(170, 98);                  // coords in screenshot pixels
   await b.sleep(1500);
   console.log(await b.ev('document.body.innerText'));
   await b.shot('/tmp/bb-ui-debug/s.png');  // then Read the PNG
   b.close();
   ```
   API: `ev(expr)` (awaits promises), `shot(file)`, `click(x,y)`, `sleep(ms)`,
   `send(method, params)` for any raw CDP call (`Input.*`, `Page.*`).
4. Navigate: click the thread row in the sidebar (URL becomes
   `/projects/<proj>/threads/<thr>`), then the right-panel toggle (top-right),
   then the **Beads issues** tab. Find coordinates from a screenshot or via
   `ev` + `getBoundingClientRect()`. Plugin UI renders in the main DOM (no
   iframe), so `document.querySelectorAll`/`innerText` work.
5. Drag (e.g. the tree/detail splitter): `Input.dispatchMouseEvent`
   `mousePressed` → `mouseMoved` (`buttons:1`) → `mouseReleased`.
6. Always finish with `bash skills/bb-ui-debug/scripts/session.sh stop`
   (releases the lease and closes the tab; leases expire after 30 min).

## Gotchas

- In zsh keep shared `bb browser` flags in an array (`H=(--host … --thread …)`),
  `$H` as a string doesn't word-split.
- Every `bb browser` call needs `--host --instance --generation --thread`;
  `session.sh` fills them in.
- The tab is the user's BB profile with signed-in authority: stay on the
  local BB UI, don't browse elsewhere.
- Screenshots are viewport-sized; coordinates from one screenshot hold only
  while layout is unchanged — re-shoot after opening/closing panels.
