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
| **agents.free-agent-mode** | Spawn agents that bypass all permission prompts (elevated — requires `agents`) |
| **notifications** | Show notices, errors, confirmations, input prompts, open URLs |
| **storage** | Persistent data storage (project, project-local, global scopes) |
| **navigation** | Focus agents, switch Explorer tabs programmatically |
| **projects** | List open projects, get active project info |
| **commands** | Register and execute commands |
| **events** | Subscribe to the application event bus |
| **widgets** | Use shared UI components (AgentTerminal, AgentAvatar, etc.) |
| **logging** | Write structured entries to the application log |
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

## Free Agent Mode

The `agents.free-agent-mode` permission lets a plugin spawn agents that skip all permission prompts. This is **elevated and dangerous** — agents run fully autonomously.

```json
{
  "permissions": ["agents", "agents.free-agent-mode"]
}
```

The plugin passes `freeAgentMode: true` to `api.agents.runQuick()`. Without this permission declared, the call throws an error.

Only grant to plugins you fully trust.
