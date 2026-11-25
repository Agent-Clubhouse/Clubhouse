# App window navigation

App windows (the main window and popouts) load the renderer with the privileged preload, so they must only ever show the app's own page. Issue: #3881.

## Where a window may go

`src/main/navigation-guard.ts` `isAllowedNavigation(url, entryUrl)`, where `entryUrl` is `MAIN_WINDOW_WEBPACK_ENTRY`:

- **Packaged builds** (`file:` entry): only that exact document. Query and hash are ignored, the path is compared decoded, and a Windows drive letter compares case-insensitively. Other local files and every localhost port are blocked.
- **Dev builds** (dev-server entry): only that exact origin.

`src/main/window-security-guards.ts` applies this to `will-navigate` and `will-redirect`. Reloads, including the E2E harness's `page.reload()`, don't emit `will-navigate`, so they keep working.

## Links

A blocked http, https or mailto navigation, and any `window.open`/`target="_blank"` link with those protocols, goes to the system browser or mail app. They use the same protocol allowlist as the openExternal IPC (`OPEN_EXTERNAL_ALLOWED_PROTOCOLS`). `window.open` never creates a window (#2081). Everything else is dropped. Logs record only the protocol, never the URL, so local paths don't reach logs.

## Dropped files

Chromium's default action for a file dropped where nothing cancels the drag is to navigate the window to the file. `src/preload/file-drop-guard.ts` listens on the document in the capture phase. For drags carrying `Files` it calls `preventDefault` on `dragover` and `drop`, and never stops propagation. Surfaces that accept files (chat attachments, Canvas, file chips, FirstRun, terminals, skill bundles) still receive the event and decide what the drop does. Drags without files (text, links, internal reorders) are untouched.

The navigation rule is the backstop: even if a drop got through, a `file:` navigation away from the app page is blocked.
