# Plugins

Plugins are extensions that add custom views, commands, and integrations to Clubhouse. They allow you to tailor the application to your workflow by adding new tabs, sidebar panels, and capabilities beyond what ships out of the box.

## Plugin Scopes

Every plugin declares a scope that determines where it appears and how it runs.

| Scope | Context | Where It Appears |
|-------|---------|------------------|
| **Project** | Activated per-project; operates on a single project at a time | Tab in the Explorer Rail (second column) |
| **App** | Global; runs independently of any specific project | Icon in the Project Rail (leftmost column) |
| **Dual** | Supports both project and app contexts | Tab in the Explorer Rail *and* icon in the Project Rail |

A **project-scoped** plugin is activated separately for each project that enables it. It has access to that project's files, Git state, and agents. An **app-scoped** plugin runs once globally and is not tied to any particular project. A **dual-scoped** plugin can do both: it appears as a project tab for per-project work and as a rail icon for cross-project work.

## Built-in Plugins

Clubhouse ships with several built-in plugins. Three of them (Hub, Terminal, and Files) are enabled by default on a fresh install.

| Plugin | Scope | Description |
|--------|-------|-------------|
| **Hub** | Dual | Split-pane agent monitoring dashboard. Per-project view shows agents for a single project; cross-project view spans all projects. |
| **Terminal** | Project | Interactive terminal emulator scoped to each project's root directory. |
| **Files** | Project | File browser with a built-in Monaco editor, markdown preview, and image display. |
| **Wiki** | Project | Browse and edit markdown wikis stored in external directories. Supports GitHub and Azure DevOps wiki formats. |
| **Issues** | Project | Browse, view, and file GitHub issues for the current project using the `gh` CLI. |
| **KanBoss** | Project | Kanban boards with AI-powered automation. Cards can trigger quick agents when they enter automatic states. |
| **Automations** | Project | Schedule recurring quick-agent tasks using cron expressions. |

## Plugin Trust Levels

Every plugin in Clubhouse carries a trust-level badge that helps you understand where it came from and how much vetting it has received.

| Badge | Meaning |
|-------|---------|
| **Built-in** | Ships with Clubhouse. Maintained and tested by the Clubhouse team. Always available. |
| **Official** | A community plugin that has been reviewed and endorsed by the Clubhouse team. Distributed via the external plugins directory. |
| **Community** | A third-party plugin that has not been reviewed by the Clubhouse team. Use at your own discretion. |

Built-in plugins cannot be uninstalled. Official and Community plugins are loaded from `~/.clubhouse/plugins/` and can be added or removed freely.

## Enabling Plugins

Plugins can be enabled at two levels. A plugin must be enabled at the appropriate level before it will appear in the UI.

### App-level

Open **Settings** (gear icon in the Project Rail) and navigate to the **Plugins** section. Here you can enable or disable any registered plugin globally. Disabling a plugin at the app level prevents it from appearing in any project.

### Project-level

Open the settings for a specific project and toggle individual plugins on or off. This allows you to customize which plugins are active in each project. A plugin must first be enabled at the app level before it can be enabled for a project.

## External Plugins

External plugins are plugins that are not built into Clubhouse. They are loaded from the `~/.clubhouse/plugins/` directory on your machine.

### Master Switch

For security, external plugin loading is **disabled by default**. To enable it:

1. Open **Settings** (gear icon in the Project Rail) and navigate to the **Plugins** section.
2. Toggle **Enable External Plugins** on in the External section header.
3. Restart Clubhouse. External plugins will now be discovered and appear in the plugin list.

When external plugins are disabled, Clubhouse will not scan for or load any plugins outside of the built-in set. This provides a safe default for users who do not need third-party extensions.

### Installing External Plugins

To install an external plugin:

1. Ensure the **Enable External Plugins** master switch is turned on (see above).
2. Create or download the plugin directory.
3. Place it inside `~/.clubhouse/plugins/` (create the directory if it does not exist).
4. Restart Clubhouse or reload plugins. The plugin will appear in **Settings > Plugins** under the External section.
5. Enable it at the app level and, if it is project-scoped, enable it in the desired projects.

To uninstall an external plugin, remove its directory from `~/.clubhouse/plugins/` or use the uninstall option in plugin settings.

## Plugin UI

Where a plugin appears in the interface depends on its scope:

- **Project plugins** appear as tabs in the **Explorer Rail** (the second column). Click a tab to open that plugin's sidebar panel and main content view. The Explorer Rail shows the Agents tab alongside tabs for each enabled project-scoped plugin.
- **App plugins** appear as icons in the **Project Rail** (the leftmost column). Click an icon to open the plugin's global view.
- **Dual plugins** appear in both locations. The Hub, for example, shows a tab in the Explorer Rail for per-project agent management and an icon in the Project Rail for cross-project agent management.

## Plugin Status

Each plugin goes through a lifecycle represented by its status.

| Status | Meaning |
|--------|---------|
| **Registered** | The plugin has been discovered and its manifest has been loaded, but it is not yet enabled. |
| **Enabled** | The plugin is turned on at the app level and ready to be activated. |
| **Activated** | The plugin is running. Its `activate` function has been called and its UI is available. |
| **Deactivated** | The plugin was previously activated but has been shut down (e.g., the project was closed). |
| **Disabled** | The plugin has been explicitly turned off by the user, or was disabled due to a permission violation. |
| **Errored** | The plugin encountered an error during activation or runtime. Check the application logs for details. |
| **Incompatible** | The plugin requires an API version that is newer than the version supported by this copy of Clubhouse. |

## Plugin Badges

Plugins can display indicator badges on their tabs and rail items to signal unread counts, status changes, or other notifications. Badges come in two types:

- **Count** -- Displays a numeric value (e.g., the number of unresolved issues).
- **Dot** -- Displays a simple indicator dot to flag that something needs attention.

Badges appear on the plugin's tab in the Explorer Rail and, for app or dual-scoped plugins, on the plugin's icon in the Project Rail.

## Plugin Settings

Some plugins expose configuration options that let you customize their behavior.

### Declarative Settings

Plugins can define settings in their manifest, and Clubhouse will automatically generate a settings UI for them. The following setting types are available:

| Type | Description | Example |
|------|-------------|---------|
| **boolean** | A toggle switch for on/off options | "Show hidden files" |
| **string** | A text input field | "API endpoint URL" |
| **number** | A numeric input field | "Refresh interval (seconds)" |
| **select** | A dropdown menu with predefined choices | "Wiki format: GitHub / ADO" |
| **directory** | A folder picker with browse button and path input | "Wiki path" |

Plugins with declarative settings display the `settingsPanel: 'declarative'` indicator in their manifest. Their settings appear automatically in the plugin's settings section.

### Custom Settings Panels

Some plugins provide a fully custom settings panel instead of (or in addition to) declarative settings. These plugins render their own settings UI with complete control over layout and behavior. Custom settings panels are indicated by `settingsPanel: 'custom'` in the manifest.

### Accessing Plugin Settings

To access a plugin's settings, open **Settings** (gear icon), navigate to **Plugins**, and select the plugin. If the plugin has configurable settings, they will appear in the plugin's detail panel.
