# Creating Plugins

This guide covers how to create your own Clubhouse plugin. A plugin is a self-contained package that extends Clubhouse with custom views, commands, and integrations. The best way to learn is to study the built-in plugins that ship with Clubhouse -- they demonstrate all of the patterns described here.

## Plugin Structure

A plugin is a directory containing at minimum a manifest file, and optionally a JavaScript entry point and any supporting assets.

```
my-plugin/
  manifest.json      # Required: plugin metadata and declarations
  main.js            # Optional: entry point with activate/deactivate lifecycle
  styles.css         # Optional: additional styles
  assets/            # Optional: images, icons, etc.
```

For **built-in** plugins, the manifest is defined as a TypeScript file (`manifest.ts`) that exports a `PluginManifest` object, and the module is a TypeScript file (`main.ts`) that exports lifecycle hooks and React components. For **community** plugins installed in `~/.clubhouse/plugins/`, the manifest must be a `manifest.json` file.

## Manifest

The manifest is the most important file in a plugin. It tells Clubhouse everything it needs to know about the plugin: its identity, scope, permissions, UI contributions, and settings.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the plugin (e.g., `"my-plugin"`). Must be unique across all installed plugins. |
| `name` | string | Human-readable display name shown in the UI (e.g., `"My Plugin"`). |
| `version` | string | Semantic version string (e.g., `"1.0.0"`). |
| `engine.api` | number | The minimum Plugin API version required by this plugin. The current API version is **0.5**. |
| `scope` | string | One of `"project"`, `"app"`, or `"dual"`. Determines where the plugin appears and how it is activated. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | A short description of what the plugin does. Displayed in the plugin list and in the auto-generated About help topic. |
| `author` | string | The plugin author's name. |
| `main` | string | Path to the main JavaScript module, relative to the plugin directory. If omitted, the plugin contributes only declarative elements (settings, commands) with no runtime code. |
| `permissions` | string[] | List of permissions the plugin requires (see the Permissions help topic). Required for API v0.5 and later. |
| `settingsPanel` | string | Either `"declarative"` (auto-generated UI from settings declarations) or `"custom"` (plugin renders its own settings panel). |
| `externalRoots` | array | Declares directories outside the project that the plugin can access. Requires the `files.external` permission. |
| `allowedCommands` | string[] | Lists CLI commands the plugin is allowed to execute. Required when using the `process` permission. |
| `contributes` | object | Declares the plugin's UI contributions (tabs, rail items, commands, settings, storage, help). See below. |

### Example Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A custom plugin for my workflow.",
  "author": "Your Name",
  "engine": { "api": 0.5 },
  "scope": "project",
  "main": "main.js",
  "permissions": ["files", "notifications", "commands"],
  "settingsPanel": "declarative",
  "contributes": {
    "tab": {
      "label": "My Plugin",
      "icon": "<svg>...</svg>",
      "layout": "sidebar-content"
    },
    "commands": [
      { "id": "refresh", "title": "Refresh Data" }
    ],
    "settings": [
      {
        "key": "autoRefresh",
        "type": "boolean",
        "label": "Auto-refresh",
        "description": "Automatically refresh data when files change.",
        "default": true
      }
    ],
    "storage": { "scope": "project" },
    "help": {
      "topics": [
        { "id": "usage", "title": "Usage Guide", "content": "## Usage\n\nHow to use this plugin..." }
      ]
    }
  }
}
```

## Contributes

The `contributes` object declares everything the plugin adds to the Clubhouse UI.

### Tab (Project and Dual Scopes)

A `tab` entry adds a tab to the Explorer Rail for project-scoped and dual-scoped plugins.

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | The text displayed on the tab. |
| `icon` | string | An SVG string or icon name for the tab icon. |
| `layout` | string | Either `"sidebar-content"` (default, two-column layout with sidebar and main panel) or `"full"` (single full-width panel). |

### Rail Item (App and Dual Scopes)

A `railItem` entry adds an icon to the Project Rail for app-scoped and dual-scoped plugins.

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Tooltip text shown when hovering over the rail icon. |
| `icon` | string | An SVG string or icon name. |
| `position` | string | Either `"top"` (default) or `"bottom"` to control placement in the rail. |

### Commands

An array of command declarations. Each command has an `id` and a `title`. The `id` is used to register and execute the command programmatically. The `title` is the human-readable name shown in the UI.

```json
"commands": [
  { "id": "refresh", "title": "Refresh Data" },
  { "id": "export", "title": "Export Results" }
]
```

### Settings (Declarative)

An array of setting declarations. Each setting is automatically rendered in the plugin's settings panel.

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Unique key for this setting within the plugin. |
| `type` | string | One of `"boolean"`, `"string"`, `"number"`, `"select"`, or `"directory"`. |
| `label` | string | Display label for the setting. |
| `description` | string | Optional help text shown below the setting control. |
| `default` | varies | Default value used when the setting has not been configured. |
| `options` | array | Required for `"select"` type. An array of `{ "label": "...", "value": "..." }` objects defining the dropdown choices. |

### Storage

Declares a storage scope for the plugin.

| Scope | Location | Git Behavior |
|-------|----------|--------------|
| `project` | `.clubhouse/plugin-data/{pluginId}/` | Committed to version control |
| `project-local` | `.clubhouse/plugin-data-local/{pluginId}/` | Gitignored (local only) |
| `global` | `~/.clubhouse/plugin-data/{pluginId}/` | Per-user, outside any project |

### Help Topics

Plugins can contribute markdown help topics that appear in the Clubhouse help system under the plugin's section.

```json
"help": {
  "topics": [
    {
      "id": "getting-started",
      "title": "Getting Started",
      "content": "## Getting Started\n\nInstructions for using this plugin..."
    }
  ]
}
```

Each plugin also receives an auto-generated **About** topic that displays the plugin name, version, author, API version, and scope. Custom topics are appended after the About topic.

## Plugin API Namespaces

When a plugin is activated, it receives a `PluginAPI` object with the following namespaces. Each namespace is only available if the plugin has declared the corresponding permission.

| Namespace | Permission | Description |
|-----------|------------|-------------|
| `api.project` | files | Read and write files within the project. Provides `readFile`, `writeFile`, `deleteFile`, `fileExists`, `listDirectory`, and access to `projectPath` and `projectId`. |
| `api.files` | files | Extended file operations: `readTree`, `readBinary`, `stat`, `rename`, `copy`, `mkdir`, `delete`, `showInFolder`. Use `forRoot(name)` for external roots. |
| `api.git` | git | Query Git state: `status()`, `log()`, `currentBranch()`, `diff()`. |
| `api.agents` | agents | Manage agents: `list()`, `runQuick()`, `kill()`, `resume()`, `listCompleted()`, `getDetailedStatus()`, `getModelOptions()`. Subscribe via `onStatusChange()` and `onAnyChange()`. |
| `api.ui` | notifications | Show notifications and prompts: `showNotice()`, `showError()`, `showConfirm()`, `showInput()`, `openExternalUrl()`. |
| `api.storage` | storage | Persistent storage with three scopes: `project`, `projectLocal`, `global`. Each scope supports `read()`, `write()`, `delete()`, `list()`. |
| `api.terminal` | terminal | Shell sessions: `spawn()`, `write()`, `resize()`, `kill()`, `getBuffer()`, `onData()`, `onExit()`. Also provides the `ShellTerminal` React component. |
| `api.navigation` | navigation | UI control: `focusAgent(agentId)`, `setExplorerTab(tabId)`. |
| `api.process` | process | Execute CLI commands: `exec(command, args, options)`. Only commands listed in `allowedCommands` are permitted. |
| `api.badges` | badges | Manage badge indicators: `set()`, `clear()`, `clearAll()`. |
| `api.logging` | logging | Structured logging: `debug()`, `info()`, `warn()`, `error()`, `fatal()`. Each method accepts a message and an optional metadata object. |
| `api.events` | events | Event bus: `on(event, handler)` returns a `Disposable` to unsubscribe. |
| `api.commands` | commands | Command registry: `register(commandId, handler)`, `execute(commandId, ...args)`. |
| `api.projects` | projects | Project information: `list()`, `getActive()`. |
| `api.widgets` | widgets | Shared React components: `AgentTerminal`, `SleepingAgent`, `AgentAvatar`, `QuickAgentGhost`. |
| `api.context` | -- | Always available. Provides `mode` (`"project"` or `"app"`), `projectId`, and `projectPath`. |
| `api.settings` | -- | Always available. Provides `get(key)`, `getAll()`, and `onChange(callback)` to read and react to the plugin's settings. |

## API Version Compatibility

Plugins declare the minimum API version they require via the `engine.api` field in the manifest. The current API version is **0.5**. If a plugin requires an API version that is newer than what the running copy of Clubhouse supports, the plugin will be marked as **incompatible** and will not activate.

When the API evolves, new permissions and namespaces may be added. Existing permissions and their behavior remain stable within a major version.

## Plugin Module

If the plugin specifies a `main` entry point, the module can export any of the following:

| Export | Type | Description |
|--------|------|-------------|
| `activate` | function | Called when the plugin is activated. Receives `PluginContext` and `PluginAPI` as arguments. Use this to set up event listeners, register commands, and initialize state. May be async. |
| `deactivate` | function | Called when the plugin is deactivated (e.g., the project is closed or the plugin is disabled). Use this to clean up resources. May be async. |
| `MainPanel` | React component | Rendered in the main content area. Receives `{ api: PluginAPI }` as props. |
| `SidebarPanel` | React component | Rendered in the sidebar/accessory panel (for `sidebar-content` layout). Receives `{ api: PluginAPI }` as props. |
| `SettingsPanel` | React component | Custom settings UI (when `settingsPanel: 'custom'`). Receives `{ api: PluginAPI }` as props. |
| `HubPanel` | React component | Special panel for dual-scoped plugins that integrate with the Hub. Receives `{ paneId, resourceId }` as props. |

## Plugin Settings

Settings can be accessed at runtime through the `api.settings` namespace, which is always available regardless of permissions.

- `api.settings.get<T>(key)` -- Returns the current value for a setting key, or `undefined` if not set.
- `api.settings.getAll()` -- Returns all settings as a key-value object.
- `api.settings.onChange(callback)` -- Subscribes to setting changes. The callback receives the key and new value.

## Plugin Storage

The storage API provides persistent data storage at three scopes.

| Scope | Location | Description |
|-------|----------|-------------|
| `project` | `.clubhouse/plugin-data/{pluginId}/` | Data committed to version control. Shared across team members who use the same repository. |
| `projectLocal` | `.clubhouse/plugin-data-local/{pluginId}/` | Data that stays local to this machine. The path is automatically added to `.gitignore`. |
| `global` | `~/.clubhouse/plugin-data/{pluginId}/` | Data stored in the user's home directory, shared across all projects. |

Each scope provides four operations:

- `read(key)` -- Read a value by key. Returns the stored value or `undefined`.
- `write(key, value)` -- Write a value. The value is serialized as JSON.
- `delete(key)` -- Delete a stored key.
- `list()` -- List all keys in this scope.

## Plugin File Access

Plugins with the `files` permission can read and write files within the project directory. The primary file operations are:

- `readFile(relativePath)` -- Read a file's text content.
- `writeFile(relativePath, content)` -- Write text content to a file.
- `deleteFile(relativePath)` -- Delete a file.
- `fileExists(relativePath)` -- Check whether a file exists.
- `listDirectory(relativePath)` -- List the contents of a directory. Returns an array of entries with `name`, `path`, and `isDirectory` properties.

The extended files API (`api.files`) adds further capabilities: `readTree` (recursive directory listing), `readBinary` (base64-encoded binary content), `stat` (file metadata), `rename`, `copy`, `mkdir`, `delete`, and `showInFolder` (reveal in system file manager).

All paths are relative to the project root. Attempting to access paths outside the project directory will fail unless the plugin has the `files.external` permission and has declared the appropriate external roots.

## Gitignore Management

Clubhouse provides internal gitignore management for plugins. When a plugin uses `project-local` storage, the storage path is automatically gitignored. Plugins can also programmatically add and remove `.gitignore` entries through the backend services. Each entry added by a plugin is tagged with a comment identifying the plugin, so entries can be cleanly removed when the plugin is uninstalled or deactivated.

## Best Practices

- **Study the built-in plugins.** The Hub, Terminal, Files, Wiki, Issues, KanBoss, and Automations plugins demonstrate all major plugin patterns: dual-scope rendering, external file access, process execution, declarative settings, custom help topics, badge indicators, and agent integration.
- **Request only the permissions you need.** Each permission grants access to a specific API namespace. Requesting unnecessary permissions may cause users to hesitate before enabling your plugin.
- **Declare allowed commands explicitly.** If your plugin uses the `process` permission, list every command it will run in the `allowedCommands` array. This gives users confidence in what the plugin will execute on their machine.
- **Use declarative settings when possible.** Clubhouse generates a consistent settings UI automatically from your setting declarations. Use a custom settings panel only when you need UI that goes beyond simple toggles, text fields, and dropdowns.
- **Provide help topics.** Add help content via `contributes.help.topics` so users can learn about your plugin without leaving the app. Clubhouse automatically generates an About topic from your manifest, but custom topics let you document features, keyboard shortcuts, and workflows.
- **Clean up in `deactivate`.** If your `activate` function sets up event listeners, intervals, or other resources, dispose of them in `deactivate` to avoid leaks. Add disposables to `ctx.subscriptions` for automatic cleanup.
- **Use storage scopes appropriately.** Use `project` storage for data that should be shared with teammates via version control. Use `project-local` for machine-specific data. Use `global` for user preferences that apply across all projects.
