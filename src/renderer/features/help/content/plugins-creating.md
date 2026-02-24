# Creating Plugins

Build custom plugins to extend Clubhouse with new views, commands, and integrations. Study the built-in plugins (Hub, Terminal, Files) for working examples of all patterns.

## Plugin Structure

```
my-plugin/
  manifest.json      # Required: metadata and declarations
  main.js            # Optional: entry point with lifecycle hooks
  styles.css         # Optional: custom styles
  assets/            # Optional: images, icons
```

Community plugins use `manifest.json`. Built-in plugins use TypeScript (`manifest.ts`, `main.ts`).

## Manifest (Required Fields)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": { "api": 0.5 },
  "scope": "project"
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Display name |
| `version` | Semver string |
| `engine.api` | Minimum Plugin API version (current: **0.5**) |
| `scope` | `"project"`, `"app"`, or `"dual"` |

**Optional:** `description`, `author`, `main`, `permissions`, `settingsPanel`, `externalRoots`, `allowedCommands`, `contributes`

## UI Contributions (`contributes`)

| Key | What It Adds |
|-----|-------------|
| `tab` | Explorer Rail tab (`label`, `icon`, `layout`: `"sidebar-content"` or `"full"`) |
| `railItem` | Project Rail icon (`label`, `icon`, `position`: `"top"` or `"bottom"`) |
| `commands` | Command palette entries (`id`, `title`) |
| `settings` | Auto-generated settings UI (boolean, string, number, select, directory) |
| `storage` | Persistent data scope (`project`, `project-local`, `global`) |
| `help.topics` | Help articles that appear in the help system |

## Module Exports

| Export | Purpose |
|--------|---------|
| `activate(ctx, api)` | Setup: register commands, event listeners, initialize state |
| `deactivate()` | Cleanup: dispose resources |
| `MainPanel` | React component for the main content area |
| `SidebarPanel` | React component for the accessory panel |
| `SettingsPanel` | Custom settings UI (when `settingsPanel: 'custom'`) |
| `HubPanel` | Panel for Hub integration (dual-scoped plugins) |

All receive `{ api: PluginAPI }` as props (except `HubPanel` which gets `{ paneId, resourceId }`).

## Key API Namespaces

| Namespace | Permission | Key Methods |
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

## Best Practices

- Request only the permissions you need
- Declare `allowedCommands` explicitly for `process` permission
- Use declarative settings when possible
- Provide help topics via `contributes.help.topics`
- Clean up resources in `deactivate` (or use `ctx.subscriptions`)
- Use the right storage scope: `project` for shared, `project-local` for machine-specific, `global` for cross-project
