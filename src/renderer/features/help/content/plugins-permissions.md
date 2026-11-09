# Plugin Permissions

Clubhouse enforces a permission system that controls what each plugin can access. Plugins declare required permissions in their manifest, and Clubhouse blocks undeclared access at runtime.

## Permission Reference

| Permission | Grants Access To |
|------------|-----------------|
| **files** | Read/write files within the project directory |
| **files.external** | Access files outside the project (requires declared external roots) |
| **git** | Git status, log, branches, diffs |
| **terminal** | Spawn and control shell sessions |
| **agents** | List, run, kill, resume, and monitor agents |
| **agents.free-agent-mode** | Start agents above Ask first, at Auto or Full access (elevated, requires `agents`) |
| **notifications** | Show notices, errors, confirmations, input prompts, open URLs |
| **storage** | Persistent data storage (project, project-local, global scopes) |
| **navigation** | Focus agents, switch Explorer tabs programmatically |
| **projects** | List open projects, get active project info |
| **commands** | Register and execute commands |
| **events** | Subscribe to the application event bus |
| **widgets** | Use shared UI components (AgentView, AgentTerminal, AgentAvatar, etc.) |
| **logging** | Write diagnostic lines to the local record, under the plugin's `plugin:<id>` namespace |
| **process** | Execute allowed CLI commands (requires `allowedCommands` list) |
| **badges** | Set/clear badge indicators on tabs and rail items |

## Permission Violations

If a plugin calls an API it hasn't declared:
1. The call is **blocked**
2. A **red banner** identifies the plugin and missing permission
3. The plugin is **automatically disabled**

Re-enable after updating the manifest to include the missing permission.

## External File Roots

Plugins needing files outside the project must:
1. Declare `files.external` permission
2. Declare `externalRoots` in the manifest mapping settings keys to named roots

```json
{
  "permissions": ["files", "files.external"],
  "externalRoots": [{ "settingKey": "docsPath", "root": "docs" }]
}
```

The user controls which directories are exposed via the setting value. The plugin accesses files via `api.files.forRoot('docs')`.

## Allowed Commands

Plugins with `process` permission must list exactly which CLI commands they can run:

```json
{
  "permissions": ["process"],
  "allowedCommands": ["gh"]
}
```

Any unlisted command is blocked.

## Starting agents above Ask first

The `agents.free-agent-mode` permission lets a plugin start agents at Auto or Full access. The plugin passes `freeAgentMode: true` to `api.agents.runQuick()`. Without this permission declared, the call throws an error.

While a plugin is answering an agent's call to one of its MCP tools, it can't start an agent above the level that agent runs at, as no agent can on its own. The call throws an error that names both levels. Everything else the plugin changes in that time follows the same rule: it can't create, stop or resume an agent, change a project's agent defaults or `.clubhouse` folder, edit files, run commands or use a shell unless the agent it's answering could do that itself, at its Access level and with its Clubhouse permissions. It can't change Clubhouse's own records for a project, change another desktop, run another plugin's commands or open your browser then. This applies to everything the plugin does until it has answered, including what you do from its view in that time. Otherwise it starts agents for you with what its manifest allows.

```json
{
  "permissions": ["agents", "agents.free-agent-mode"]
}
```

The agent starts at your **Default access** in **Settings > Agents & providers** when that is **Auto** or **Full access**. Otherwise it starts at the level Clubhouse used for these agents before the Access setting: **Full access**, or **Auto** if you had picked Auto. With Auto, a check decides what needs your approval, and it can be wrong. Without `freeAgentMode`, a plugin's agents start at your Default access.

Only grant to plugins you fully trust.
