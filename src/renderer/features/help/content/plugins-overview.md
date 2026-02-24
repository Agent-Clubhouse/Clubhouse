# Installing & Using Plugins

Plugins extend Clubhouse with custom views, commands, and integrations.

## Plugin Scopes

| Scope | Where It Appears | Context |
|-------|------------------|---------|
| **Project** | Tab in the Explorer Rail | Per-project; accesses that project's files, Git, and agents |
| **App** | Icon in the Project Rail | Global; not tied to any project |
| **Dual** | Both locations | Works in project and global contexts |

## Built-in Plugins

| Plugin | Scope | Description |
|--------|-------|-------------|
| **Hub** | Dual | Split-pane agent monitoring workspace |
| **Terminal** | Project | Interactive terminal scoped to the project root |
| **Files** | Project | File browser with Monaco editor, markdown preview, and image display |

## How to Enable Plugins

**Step 1: App-level** — **Settings > Plugins** — toggle on globally.

**Step 2: Project-level** — **Project Settings > Plugins** — toggle on for specific projects. A plugin must be enabled at the app level first.

## Installing External Plugins

External plugins load from `~/.clubhouse/plugins/`. External loading is **disabled by default** for security.

1. **Settings > Plugins** — Enable **External Plugins** in the External section
2. Download or create a plugin directory
3. Place it in `~/.clubhouse/plugins/`
4. Restart Clubhouse
5. Enable at app level, then per-project as needed

To uninstall, remove the directory from `~/.clubhouse/plugins/` or use the uninstall option in plugin settings.

## Trust Levels

| Badge | Meaning |
|-------|---------|
| **Built-in** | Ships with Clubhouse. Always available. |
| **Official** | Community plugin reviewed by the Clubhouse team. |
| **Community** | Third-party, unreviewed. Use at your own discretion. |

## Plugin Lifecycle

| Status | Meaning |
|--------|---------|
| **Registered** | Discovered, manifest loaded, not yet enabled |
| **Enabled** | Turned on at app level, ready to activate |
| **Activated** | Running, UI available |
| **Disabled** | Turned off by user or auto-disabled (permission violation) |
| **Errored** | Failed during activation or runtime — check logs |
| **Incompatible** | Requires a newer API version than your Clubhouse supports |

## Badges

Plugins can show indicator badges on their tabs/icons:
- **Count** — numeric value (e.g., unresolved issues)
- **Dot** — simple attention indicator

## Plugin Settings

Some plugins expose settings (boolean, string, number, select, directory). Access via **Settings > Plugins > [Plugin Name]**.
