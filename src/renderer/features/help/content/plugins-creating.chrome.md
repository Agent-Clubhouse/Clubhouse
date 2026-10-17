# Creating plugins

Build custom plugins to extend Clubhouse with new views, commands, and integrations. Built-in plugins are host-integrated examples, not portable community-plugin templates: they may import internal stores, hooks, features, and components that are unavailable to dynamically loaded plugins. Use the public `PluginAPI` surface below for community plugins; in particular, use `api.ui.EmptyState` for empty panels, `api.navigation.popOutAgent` to pop an agent out to its own window, `api.widgets.AgentView` to show an agent's live view (chat or terminal, whichever it runs in), and `api.window.usePopoutState()` with `api.widgets.PopoutPlaceholder` to detect when your plugin's own view has been popped out and render a placeholder instead of duplicating it.

## Plugin structure

```
my-plugin/
  manifest.json      # Required: metadata and declarations
  main.js            # Optional: entry point with lifecycle hooks
  styles.css         # Optional: custom styles
  assets/            # Optional: images, icons
```

Community plugins use `manifest.json`. Built-in plugins use TypeScript (`manifest.ts`, `main.ts`).

## Required manifest fields

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": { "api": 0.9 },
  "scope": "project"
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Display name |
| `version` | Semver string |
| `engine.api` | Plugin API version (current: **0.9**; 0.5 and 0.6 are deprecated) |
| `scope` | `"project"`, `"app"`, or `"dual"` |

**Optional:** `description`, `author`, `main`, `permissions`, `settingsPanel`, `externalRoots`, `allowedCommands`, `contributes`

## UI contributions (`contributes`)

| Key | What it adds |
|-----|-------------|
| `tab` | A project tab in the title bar (`label`, `icon`, `layout`). With `"sidebar-content"`, your `SidebarPanel` replaces the sidebar's agent tree while the tab is open. With `"full"`, the tree stays and `MainPanel` fills the pane. |
| `railItem` | An app-wide entry in the sidebar (`label`, `icon`, `position`). `"top"` puts it in the row under Search, or its **More** menu. `"bottom"` puts an icon in the sidebar footer. |
| `commands` | Command palette entries (`id`, `title`) |
| `settings` | Auto-generated settings UI (boolean, string, number, select, directory) |
| `storage` | Persistent data scope (`project`, `project-local`, `global`) |
| `help.topics` | Help articles that appear in the help system |

## Module exports

| Export | Purpose |
|--------|---------|
| `activate(ctx, api)` | Setup: register commands, event listeners, initialize state |
| `deactivate()` | Cleanup: dispose resources |
| `MainPanel` | React component for the main content area |
| `SidebarPanel` | React component for the sidebar list (with the `"sidebar-content"` layout) |
| `SettingsPanel` | Custom settings UI (when `settingsPanel: 'custom'`) |

All receive `{ api: PluginAPI }` as props.

## Key API namespaces

| Namespace | Permission | Main methods |
|-----------|------------|-------------|
| `api.project` | files | `readFile`, `writeFile`, `deleteFile`, `listDirectory` |
| `api.files` | files | `readTree`, `stat`, `rename`, `copy`, `showInFolder` |
| `api.git` | git | `status`, `log`, `currentBranch`, `diff` |
| `api.agents` | agents | `list`, `runQuick`, `kill`, `resume`, `onStatusChange` |
| `api.ui` | notifications | `showNotice`, `showError`, `showConfirm`, `showInput` |
| `api.storage` | storage | `read`, `write`, `delete`, `list` (3 scopes) |
| `api.terminal` | terminal | `spawn`, `write`, `resize`, `kill`, `onData` |
| `api.process` | process | `exec(command, args, options)` |
| `api.context` | *(always)* | `mode`, `projectId`, `projectPath` |
| `api.settings` | *(always)* | `get`, `getAll`, `onChange` |

## Good practice

- Request only the permissions you need
- Declare `allowedCommands` explicitly for `process` permission
- Use declarative settings when possible
- Provide help topics via `contributes.help.topics`
- Clean up resources in `deactivate` (or use `ctx.subscriptions`)
- Use the right storage scope: `project` for shared, `project-local` for machine-specific, `global` for cross-project
