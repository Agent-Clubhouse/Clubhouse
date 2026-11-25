# App window navigation

App windows (the main window and popouts) load the renderer with the privileged preload, so they must only ever show the app's own page. Issue: #3881.

## Where a window may go

`src/main/navigation-guard.ts` `isAllowedNavigation(url, entryUrl)`, where `entryUrl` is `MAIN_WINDOW_WEBPACK_ENTRY`:

- **Packaged builds** (`file:` entry): only that exact document. Query and hash are ignored, the path is compared decoded, and a Windows drive letter compares case-insensitively. Other local files and every localhost port are blocked.
- **Dev builds** (dev-server entry): only that exact origin.

`src/main/window-security-guards.ts` applies this to `will-navigate` and `will-redirect`. Reloads, including the E2E harness's `page.reload()`, don't emit `will-navigate`, so they keep working.

### What these hooks don't cover

`will-navigate` and `will-redirect` don't fire for programmatic loads: `webContents.loadURL` from main, `location.reload()`, or `history.pushState` followed by a reload. That's acceptable. Each of these needs code already running in the privileged renderer or in main, and that code can call the preload API directly, so blocking its navigations would add nothing. The hooks exist for navigations that page content or the user can start without such code: link clicks, form posts, dropped files and links, and redirects.

`will-redirect` doesn't check `isMainFrame`. App windows have no subframes today. If one is added, its redirects are held to the same entry-only rule, which fails closed.

## Links

A blocked http, https or mailto navigation, and any `window.open`/`target="_blank"` link with those protocols, goes to the system browser or mail app. They use the same protocol allowlist as the openExternal IPC (`OPEN_EXTERNAL_ALLOWED_PROTOCOLS`). `window.open` never creates a window (#2081). Everything else is dropped. Logs record only the protocol, never the URL, so local paths don't reach logs.

## Dropped files and links

Chromium's default action for a file or link dropped where nothing cancels the drag is to navigate the window to it. `src/preload/file-drop-guard.ts` listens on the document in the capture phase and only ever calls `preventDefault`, never `stopPropagation`:

- **Files:** `dragover` and `drop` are always cancelled.
- **Links** (`text/uri-list` without files): cancelled too, except over an editable field (input, textarea, contenteditable), where the browser's own default inserts the link as text. Without this, a stray link drop would be blocked by main and then opened in the system browser.
- **Other drags** (plain text, internal reorders) are untouched.

Surfaces that accept files or links (chat attachments, Canvas, file chips, FirstRun, terminals, skill bundles) still receive the event and decide what the drop does.

The navigation rule is the backstop: even if a drop got through, a `file:` navigation away from the app page is blocked.
