# Project Settings

Project settings allow you to customize how a project appears in Clubhouse, configure its AI backend, manage plugin enablement, and perform administrative actions like closing or resetting the project.

## Accessing Project Settings

There are two ways to open project settings:

1. **Gear icon** — Select a project in the Project Rail, then click the gear icon in the project header area.
2. **Settings menu** — Open the application Settings panel and navigate to the **Project** section while the desired project is selected.

Both paths open the same settings view. Changes are saved automatically as you make them.

## Display Name

By default, Clubhouse uses the folder name as the project's display name. You can override this with a custom name that better describes the project.

- The display name appears in the Project Rail tooltip, the project header, and anywhere the project is referenced in the UI.
- Changing the display name does not rename the folder on disk. It is purely a cosmetic setting within Clubhouse.
- To revert to the folder name, clear the custom name field.

## Color

Each project has an **accent color** that is used for its icon in the Project Rail and for visual identification throughout the interface.

- Choose from 10 or more preset accent colors.
- The color is applied to the project icon background and is also used as a subtle tint in headers and borders when the project is selected.
- Assigning distinct colors to your projects makes it easier to identify them at a glance, especially when you have many projects in the rail.

## Icon

You can upload a **custom icon image** to replace the default letter-based project icon.

- Click the icon area in project settings to open a file picker dialog.
- Select an image file (PNG, JPG, or SVG are supported).
- A preview of the icon is shown in the settings view after upload.
- To remove a custom icon and revert to the default letter icon, click the remove button next to the icon preview.

Custom icons are displayed in the Project Rail and in the project header. They are stored within the `.clubhouse/` directory for the project.

## Orchestrator

The **orchestrator** determines which AI backend powers the agents in this project. Clubhouse supports multiple orchestrators:

| Orchestrator | Description |
|-------------|-------------|
| **Claude Code** | Anthropic's Claude-powered coding CLI |
| **Copilot CLI** | GitHub Copilot's command-line interface |
| **OpenCode** | Open-source AI coding backend |

- Select an orchestrator from the dropdown menu in project settings.
- The chosen orchestrator applies to all agents created in this project, both durable and quick.
- Changing the orchestrator does not affect agents that are already running. The new orchestrator will be used for agents created or restarted after the change.
- Available orchestrators depend on which CLI tools are installed on your system and which API keys are configured in the global Clubhouse settings.

## Per-Project Plugin Enablement

Plugins installed in Clubhouse can be enabled or disabled on a per-project basis. This is useful when certain plugins are relevant to some projects but not others.

- The plugin enablement section lists all installed plugins with a toggle for each.
- Enabling a plugin makes it available to agents working in this project. Disabling it prevents agents from using that plugin's capabilities.
- Plugin toggles take effect immediately. Running agents will pick up the change the next time they interact with the plugin system.
- Global plugin settings (such as API keys or configuration) are managed in the application-wide Settings panel, not in project settings.

## Danger Zone

The danger zone contains destructive actions that cannot be easily undone. Each action requires explicit confirmation before it is executed.

### Close Project

Closing a project removes it from Clubhouse. This means:

- The project icon is removed from the Project Rail.
- All agent definitions, worktrees, and Clubhouse-specific state for the project are discarded.
- **Your files on disk are not affected.** The project folder and all source code remain exactly as they are.
- You can re-add the folder as a project at any time, but previous agent definitions and Clubhouse configuration will not be restored (unless the `.clubhouse/` directory was preserved on disk).

A confirmation dialog will appear with a clear warning before the project is closed.

### Reset Project

Resetting a project deletes all Clubhouse configuration data stored in the `.clubhouse/` directory within the project folder. This includes:

- All agent definitions (durable and quick agent history)
- Skills, templates, and instruction files
- Plugin configuration specific to the project
- Worktree metadata

After a reset, the project remains in Clubhouse but returns to a clean state, as if it had just been added for the first time. **Your source code and Git history are not affected.**

A confirmation dialog will appear with a detailed warning explaining what will be deleted. This action cannot be undone.
