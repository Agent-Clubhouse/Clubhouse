# Browser webview security

The built-in Browser (project tab and the `plugin:browser:webview` Canvas widget) shows pages in Electron `<webview>` guests. The main process enforces the rules below in `src/main/window-security-guards.ts`. The renderer's own URL checks (`src/renderer/plugins/builtin/browser/url-validation.ts`) apply only to addresses typed into the Browser, so main is the only place that can enforce them for everything else. Issue: #3869.

## webPreferences

On `will-attach-webview`, main overrides whatever the `<webview>` tag asked for:

- `nodeIntegration`, `nodeIntegrationInSubFrames` and `nodeIntegrationInWorker`: `false`
- `contextIsolation`, `sandbox` and `webSecurity`: `true`
- `allowRunningInsecureContent`: `false`
- `preload` and `preloadURL`: removed. The app has no webview preload.

## Allowed URLs

| Where | Allowed |
|---|---|
| First page (`will-attach-webview`) | `http:`, `https:`, `about:blank`, and `file:` when the setting is on |
| Main-frame navigation and redirects (`will-navigate`, `will-redirect`) | Same as the first page |
| Subframes (`will-frame-navigate`, subframe `will-redirect`) | The above, plus `about:`, `data:` and `blob:` |

Everything else (`javascript:`, `chrome:`, `devtools:`, custom app schemes and so on) is blocked and logged under `core:security`.

Pages can't open windows: the guest's `setWindowOpenHandler` always denies. The `<webview>` tags never set `allowpopups`, so this matches earlier behavior.

## Local files

`file:` is off by default. The one control is the Browser's **Allow file:// URLs** setting (Settings > Plugins > Browser). It's saved per scope as `settings-<scope>-browser.json` in the host plugin KV store. The renderer applies it for its own scope. Main can't tell which scope a webview belongs to, so it allows `file:` when the setting is on in the app scope or any project scope (`src/main/browser-file-access.ts`). Read failures count as off.

The old `allowLocalFileWebviews` key in `security-settings.json` had no UI and is retired. Saved values stay on disk; nothing reads them.

## Agent Browser tools

The agent tools (`src/main/services/clubhouse-mcp/tools/browser-tools.ts`, grants `browser.read` and `browser.act` from #2988) are unchanged. `navigate` accepts only `http:` and `https:` and calls `loadURL`, which these guards allow. Pages that an agent's `click` or `evaluate` sends somewhere go through the same navigation guard as a user's click.
