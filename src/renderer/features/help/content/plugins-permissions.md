# Plugin Permissions

Clubhouse uses a permission system (introduced in API v0.5) to control what each plugin can access. Plugins must declare the permissions they need in their manifest, and Clubhouse enforces those declarations at runtime. This protects your projects and data from plugins that attempt to access resources they have not been granted.

## How Permissions Work

Every plugin manifest includes a `permissions` array listing the capabilities the plugin requires. When a plugin is activated, Clubhouse creates an API object that only exposes the namespaces matching the declared permissions. If a plugin attempts to call an API it has not declared, the call is blocked and a permission violation is recorded.

## Permission Reference

The following table lists all 15 available permissions.

| Permission | Description |
|------------|-------------|
| **files** | Read and write files within the project directory. Grants access to the files API for reading, writing, deleting, copying, renaming, and listing files and directories scoped to the project root. |
| **files.external** | Access files outside the project directory. Requires the plugin to declare external roots (see below). Without this permission, all file operations are restricted to the project directory. |
| **git** | Read Git status, log, branches, and diffs. Allows the plugin to query the current branch, view commit history, check file status, and read diffs for the project repository. |
| **terminal** | Spawn and control terminal sessions. Grants the ability to create interactive shell sessions, write input to them, resize them, and subscribe to their output and exit events. |
| **agents** | Spawn, monitor, and manage AI agents. Allows listing agents, running quick agents, killing or resuming agents, viewing detailed status, and subscribing to status change events. |
| **notifications** | Display notices, errors, confirmations, and input prompts. Grants access to the UI notification methods: `showNotice`, `showError`, `showConfirm`, `showInput`, and `openExternalUrl`. |
| **storage** | Store and retrieve persistent plugin data. Provides access to three storage scopes: project (committed), project-local (gitignored), and global (user home). Each scope supports read, write, delete, and list operations. |
| **navigation** | Navigate the Clubhouse UI. Allows the plugin to programmatically focus an agent or switch the active Explorer Rail tab. |
| **projects** | List and access other open projects. Grants the ability to enumerate all projects currently open in Clubhouse and retrieve the active project's information. |
| **commands** | Register and execute commands. Allows the plugin to register command handlers that can be invoked by other plugins or the user, and to execute commands registered by other plugins. |
| **events** | Subscribe to the event bus. Allows the plugin to listen for application-wide events such as project changes, agent status updates, and other signals. |
| **widgets** | Use shared UI widget components. Grants access to reusable React components provided by Clubhouse, including `AgentTerminal`, `SleepingAgent`, `AgentAvatar`, and `QuickAgentGhost`. |
| **logging** | Write to the application log. Provides structured logging methods at five levels: `debug`, `info`, `warn`, `error`, and `fatal`. Log entries are written to the application log with the plugin ID as context. |
| **process** | Execute allowed CLI commands. Grants the ability to run external command-line programs. This permission requires the plugin to also declare an `allowedCommands` list in the manifest (see below). |
| **badges** | Display badge indicators on tabs and rail items. Allows the plugin to set, update, and clear count or dot badges on its own tab and rail icon. |

## Permission Violations

When a plugin attempts to use an API that it has not declared in its `permissions` array, Clubhouse takes the following actions:

1. The API call is blocked and an error is thrown.
2. A **red banner** appears at the top of the Clubhouse window identifying the plugin, the API it tried to access, and the permission it is missing.
3. The plugin is **automatically disabled** to prevent further unauthorized access.

You can dismiss the violation banner by clicking the close button. If you believe the plugin should have the permission it attempted to use, you can re-enable the plugin after updating its manifest to include the required permission.

## External File Roots

By default, plugins with the `files` permission can only access files within the project directory. Some plugins need to work with files outside the project -- for example, the Wiki plugin reads markdown files from an external wiki directory.

To enable this, a plugin must:

1. Declare the `files.external` permission in its `permissions` array.
2. Declare one or more **external roots** in its manifest using the `externalRoots` field.

Each external root maps a settings key to a named root:

```json
{
  "permissions": ["files", "files.external"],
  "externalRoots": [
    { "settingKey": "wikiPath", "root": "wiki" }
  ]
}
```

In this example, the plugin reads the directory path from its `wikiPath` setting and exposes it as the `wiki` root. In code, the plugin accesses files in that directory via `api.files.forRoot('wiki')`, which returns a scoped `FilesAPI` instance limited to the configured path.

The user controls which directories are exposed by configuring the setting value. The plugin cannot access arbitrary paths outside the project -- only the directories explicitly configured through its declared external roots.

## Allowed Commands

Plugins that use the `process` permission must declare exactly which CLI commands they are allowed to execute. This prevents a plugin from running arbitrary programs on your machine.

The allowed commands are declared in the manifest's `allowedCommands` array:

```json
{
  "permissions": ["process"],
  "allowedCommands": ["gh"]
}
```

In this example, the plugin can only execute the `gh` (GitHub CLI) command. Any attempt to run a command not in the `allowedCommands` list will be blocked.

This is a safety mechanism: even if you trust a plugin enough to grant it the `process` permission, you can see at a glance which specific programs it will run. The Issues plugin, for instance, declares `["gh"]` because it needs the GitHub CLI to fetch and create issues, but it cannot run any other command.
