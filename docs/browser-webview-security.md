# Browser webview security

The built-in Browser (project tab and the `plugin:browser:webview` Canvas widget) shows pages in Electron `<webview>` guests. The main process enforces the rules below in `src/main/window-security-guards.ts`. The renderer's own URL checks (`src/renderer/plugins/builtin/browser/url-validation.ts`) apply only to addresses typed into the Browser, so main is the only place that can enforce them for everything else. Issue: #3869.

## webPreferences

On `will-attach-webview`, main overrides whatever the `<webview>` tag asked for:

- `nodeIntegration`, `nodeIntegrationInSubFrames` and `nodeIntegrationInWorker`: `false`
- `contextIsolation`, `sandbox` and `webSecurity`: `true`
- `allowRunningInsecureContent`: `false`
- `preload` and `preloadURL`: removed. The app has no webview preload.
- `webviewTag`: `false`, so a guest page can't nest its own webview (nested guests attach to the guest, where these guards don't run).

The webview must use the Browser's session, `persist:plugin-browser`. Any other partition, including none (the default session, which has the app's own `file` and plugin protocol handlers and cookies), is refused.

## Allowed URLs

| Where | Allowed |
|---|---|
| First page (`will-attach-webview`) | `http:`, `https:`, `blob:`, `about:blank`, and `file:` when the setting is on |
| Main-frame navigation and redirects (`will-navigate`, `will-redirect`) | Same as the first page |
| Programmatic main-frame loads (`did-start-navigation` backstop) | Same as the first page. Other schemes are stopped with `stop()` right after the event; `file:` is left to the session gate below |
| Any `file:` request in the Browser session (protocol handler) | Passed through only when the setting is on; otherwise a 403 and nothing read from disk |
| Subframes (`will-frame-navigate`, subframe `will-redirect`) | The above, plus `about:` and `data:` |

Everything else (`javascript:`, `chrome:`, `devtools:`, custom app schemes and so on) is blocked and logged under `core:security`.

Pages can't open windows: the guest's `setWindowOpenHandler` always denies. The `<webview>` tags never set `allowpopups`, so this matches earlier behavior.

`will-navigate`, `will-frame-navigate` and `will-redirect` don't fire for programmatic loads: the renderer changing a `<webview>` `src` after attach, `webview.loadURL()`, back and forward, or main's `webContents.loadURL`. Two things cover those.

- **`file:`:** `src/main/browser-session-guard.ts` installs a `file` protocol handler on the `persist:plugin-browser` session. It sees every `file:` request in that session, whatever started it: the first src, a src change, `loadURL`, history, a redirect or a subframe. When the setting is off everywhere it answers 403. Otherwise it passes the request to Chromium's own file handling with `net.fetch(request, { bypassCustomProtocolHandlers: true })`, so allowed local files load as before. The bypass flag means the pass-through never comes back into this handler. If it fails (a missing file, or something unreadable), the handler answers a plain 404 instead of throwing. The handler is installed once per process, on app ready, before the first window exists. Chromium lowercases the scheme before handlers run, and `file://localhost/…` and `file://host/…` are the same scheme, so neither gets around it. The app's own `file` handler (the CSP nonce) is on the default session and is unaffected.
- **Other disallowed schemes:** each guest's `loadURL` is wrapped in main when it attaches. The renderer's `<webview>.loadURL()` and `src` changes reach main as calls to that method (Electron's guest-view manager calls `guest[method]`), and so does the agent `navigate` tool. A disallowed scheme (`data:`, `javascript:`, `chrome:`, the app's plugin scheme and so on) is refused before any navigation starts, so nothing commits and no timing is involved. `file:` passes on to the session gate.
- **Defence in depth:** the `did-start-navigation` backstop still stops a main-frame load with a disallowed scheme. It runs `stop()` with `setImmediate`, after the event returns, and only if the guest still exists. An earlier version called `stop()` inside the event, and that crashed the main process (`SIGTRAP`) in E2E.

**Redirects never land on a local file.** `will-redirect` refuses any `file:` target in any frame, whatever the setting, instead of relying on Chromium's `ERR_UNSAFE_REDIRECT`.

## Trust boundary

- **Main is the floor.** Sandboxed, no preload, no nested webviews, the Browser session only. Pages get http, https and `blob:`, plus `file:` only when the setting is on in at least one scope. If it's off everywhere, no route loads `file://`: the Browser session's protocol gate refuses every `file:` request.
- **The renderer does the per-project check.** Main can't tell which project a webview belongs to. The partition is shared and holds saved cookies, and the attach params only carry tag attributes. The Browser tab and the Canvas widget check the setting for their own scope before they set a `file://` src. Web pages can't reach `file://` through another project's setting, because Chromium blocks web-to-file navigation and redirects.
- Binding each webview to its project in main is #3878.

## Local files

`file:` is off by default. The one control is the Browser's **Allow file:// URLs** setting (Settings > Plugins > Browser). It's saved per scope as `settings-<scope>-browser.json` in the host plugin KV store. The renderer applies it for its own scope. Main can't tell which scope a webview belongs to, so it allows `file:` when the setting is on in the app scope or any project scope (`src/main/browser-file-access.ts`), and checks again on every request. Read failures count as off.

The old `allowLocalFileWebviews` key in `security-settings.json` had no UI and is retired. Saved values stay on disk; nothing reads them.

## Agent Browser tools

The agent tools (`src/main/services/clubhouse-mcp/tools/browser-tools.ts`, grants `browser.read` and `browser.act` from #2988) are unchanged. `navigate` accepts only `http:` and `https:` and calls `loadURL`, which these guards allow. Pages that an agent's `click` or `evaluate` sends somewhere go through the same navigation guard as a user's click.

The renderer tells main which webContents a Canvas Browser widget uses (`registerWebview`, through the MCP binding IPC). Main accepts the id only for a live `webview` guest in `persist:plugin-browser`. It refuses the app window, popouts, other sessions and unknown ids, and logs the refusal under `core:security`. A refusal also drops the widget's earlier registration, so an agent's `click`, `evaluate` and the other tools can never reach a privileged page.
