# P2 — Discovery and Install

> Changes to the Clubhouse app so users can browse, install, and update plugins without leaving the app.

**Depends on:** P0a (plugins work), P1 nice-to-have but not blocking

**Risk:** Low. All new features — no modifications to existing behavior. The install service touches the filesystem but failures are non-destructive.

---

## 1. Workshop browser UI

**Files:** New UI component + new IPC handler

**Behavior:**
- New section in Settings (or a dedicated panel accessible from Settings > Plugins > "Browse Workshop")
- On open, fetches `registry.json` from a configurable URL (default: the Workshop repo's GitHub Releases or raw GitHub URL)
- Displays a list of available plugins:
  - Name, author, description, version
  - `first-party` / `community` badge
  - Permissions summary (icons or short text)
  - Install / Update / Installed status
- Search/filter by name or keyword
- Click a plugin to see its detail view (item 4)

**IPC:**
- `plugin:fetch-registry` — Main process fetches the registry URL and returns the parsed JSON. Using main process avoids CORS issues with renderer fetch.
- Cache the registry locally with a TTL (e.g., 1 hour) so the browser is instant on repeat opens.

**Risk:** Low. New isolated UI. The IPC handler is a simple HTTP GET + JSON parse.

---

## 2. One-click install

**Files:** New main-process service `plugin-installer.ts`, new IPC handlers

**Flow:**
1. User clicks "Install" on a plugin in the Workshop browser
2. Renderer sends `plugin:install` IPC with the plugin ID and release info (asset URL, sha256)
3. Main process:
   a. Downloads the zip from the asset URL to a temp directory
   b. Verifies sha256 hash of the downloaded file
   c. Extracts to `~/.clubhouse/plugins/{plugin-id}/`
   d. Validates the extracted manifest
   e. Returns success/failure to renderer
4. Renderer triggers plugin discovery refresh
5. Plugin appears in Settings > Plugins as registered, ready to enable

**Error handling:**
- Hash mismatch → delete temp file, show error "Download corrupted, try again"
- Manifest invalid → delete extracted directory, show error with validation details
- Directory already exists → prompt "Plugin already installed. Reinstall?" (overwrite)
- Network failure → show error with retry button

**IPC:**
- `plugin:install` — Download, verify, extract
- `plugin:check-installed` — Return map of installed plugin IDs → versions (for the browser to show Install vs Update vs Installed)

**Risk:** Low-medium. Filesystem operations (download, extract, write) but scoped to `~/.clubhouse/plugins/`. Failure mode is "plugin doesn't install" — user can try again. No risk to existing plugins or app state.

---

## 3. Plugin update checking

**Files:** `plugin-installer.ts`, Settings UI

**Behavior:**
- On app launch (or when Settings > Plugins is opened), compare installed community plugin versions against the cached registry
- If a newer version exists, show an "Update available" badge next to the plugin
- "Update" button triggers the same install flow as item 2 (download new version, overwrite existing)
- Optional: show a "What's new" diff or changelog link

**Risk:** Low. Read-only comparison + the existing install flow.

---

## 4. Plugin detail view

**Files:** Settings UI enhancement

**When clicking a plugin in the browser or in the installed plugins list, show:**
- Full description
- README content (fetched from the plugin's repo or included in the registry entry)
- Required permissions with explanations ("This plugin can read and write files in your project")
- Version history
- Author info / repo link
- Install size (if available from the registry)

**Risk:** Low. Pure UI.

---

## 5. Configurable registry URLs

**Files:** App settings, `plugin-installer.ts`

**Behavior:**
- In Settings > Plugins, allow adding additional registry URLs
- The Workshop browser aggregates plugins from all configured registries
- Each plugin shows which registry it came from
- Use case: organizations hosting a private registry of internal plugins

**Format:** Simple list of URLs in app settings:
```json
{
  "pluginRegistries": [
    "https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/registry.json"
  ]
}
```

The default is always included and cannot be removed (but could be disabled).

**Risk:** Low. Additive setting. The fetch/parse logic from item 1 just iterates over multiple URLs.

---

## Definition of Done

1. A user can open Settings > Plugins > Browse Workshop and see available plugins
2. Clicking "Install" downloads and installs a plugin — no terminal needed
3. Installed plugins show "Update available" when a newer version exists in the registry
4. Clicking "Update" installs the new version
5. Plugin detail view shows description, permissions, and README
