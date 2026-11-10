# Project settings: who owns what

Issue #3245 gives every project setting one owner. A project holds only its
environment: what every agent in it runs under. What an agent does belongs to
its Clubhouse-managed template and parts, or to a plain agent's own files. The
project's older agent defaults are legacy: read-only, and copied or imported
only when someone asks.

The table in code is `src/shared/project-settings-ownership.ts`. A new
`agentDefaults` key doesn't compile until it is given an owner there.

## Owners

| Owner | Settings | Where they're set | What reads them |
|-------|----------|-------------------|-----------------|
| Project environment | Agents run on (default CLI) | Project settings > Agents & providers | Every agent without its own CLI, at start. One source: `projects.json`, read by `readProjectOrchestrator` in main and `effectiveOrchestratorOf` in the renderer (#2975) |
| Project environment | Quick agent mode, Session name on quit | Same page | Quick agents and session prompts, live |
| Project environment | Source control provider, Command prefix, Turn off Auto provider here | Same page, Agent environment | Every agent, at start. The source control provider fills `@@SourceControlProvider` only for agents that aren't managed |
| Project environment | Launch wrapper | Project settings > General | Every agent, at start |
| Project environment | Managed git excludes | Agents & providers | Managed delivery |
| Managed template or agent | Instructions, skills, MCP servers, access, Clubhouse permissions, model, effort, runtime, context, helper policy, quick-run profile | The template, its parts, and the agent's own settings | Managed delivery at each start. Never the project's legacy defaults (#3243) |
| Provider-native | Permission and tool rule syntax | The CLI's own settings files in the agent's folder | The CLI |
| Plain agent | Its instructions file, MCP file, local settings, build, test and lint commands | Its own folder and settings | The CLI, and Clubhouse's wildcards |
| Legacy (read-only) | `agentDefaults.instructions`, `permissions`, `mcpJson`, `buildCommand`, `testCommand`, `lintCommand` | Shown read-only under Legacy defaults | See below |
| Retired | `agentDefaults.freeAgentMode`, `profileId`, `persona`, `mission` | Nowhere | Only one-time migrations |

## Effective value and source

For each setting an agent runs with, the value and where it came from:

| Setting | Managed agent | Plain agent |
|---------|---------------|-------------|
| CLI | Its own, else the project's Agents run on, else Claude Code | Same |
| Instructions | Its blocks, joined (Preview shows the exact file) | Its own instructions file |
| Skills | Its skill parts | Its own skills folder |
| MCP servers | Its MCP parts | Its own MCP file. Without one, the project's legacy MCP servers (Codex: always, as launch flags) |
| Permission rules | Its access level and Clubhouse permissions | Its own local settings file |
| Build, test, lint commands | Its build, test, lint and validate skills | Its own, else the project's legacy commands (they fill wildcards in the legacy MCP JSON) |
| Source control provider | Worked out from the repository | Its own, else the project's, else the app setting |
| Command prefix, launch wrapper | The project's | The project's |

`read_settings` reports the environment settings with their source. It never
returns instructions, permission rules, MCP JSON or commands, by design (see
[settings-read-mcp.md](settings-read-mcp.md)); the project's settings page
shows those.

## Legacy defaults

They're kept exactly as saved, so a rollback needs nothing restored. Nothing
writes them from the settings page any more: the page shows them read-only,
and a save of the Agent environment never includes them.

Where they still apply, until they're retired:

- **New plain agents**, only when "Copy this project's legacy defaults" is on
  in the New agent page or the classic New agent dialog. It's on by default
  while the project has legacy values, and the form lists what would be
  copied. Only into the agent's own new worktree.
- **Plain agents without an MCP file of their own** get the legacy MCP
  servers at start, with their wildcards filled from the legacy commands. The
  settings page names them.
- **Never** into a managed agent, a managed helper, or a plain agent created
  without the form: `create_managed_agent` with `managed: false`, a phone's
  `agent.create`, another computer over Annex, or the plugin API. Their result
  carries `legacyDefaults: "not_copied"` when the project has legacy values.

The switch to managed of an agent that still used Clubhouse Mode reads them,
as before (managed-agents D58).

### Copy into a plain agent

Copy to a plain agent (settings page) and the New agent copy do the same:

| Value | What happens |
|-------|--------------|
| Instructions | Written to the CLI's instructions file when it's empty, else added to the end. Skipped when the text is already there. Wildcards filled for the agent |
| Permission rules | Added to the agent's local settings, keeping its own. Skipped, with a reason, on a CLI without allow and deny rules (Copilot CLI) |
| MCP servers | Added to its MCP file, keeping servers it already has under the same name. With its own file, it no longer gets the project's servers at start. Codex: written only when it has no TOML file yet |
| Commands | Become the agent's own build, test and lint commands where it has none |

The preview lists each file or setting and what happens to it. Nothing is
written until the copy is confirmed.

### Import as parts

- The instructions become one library block, named after the project. Legacy
  commands are filled in where the text uses `@@BuildCommand`,
  `@@TestCommand` or `@@LintCommand`, and listed under "Project commands"
  otherwise. Other wildcards a managed agent doesn't fill are named in the
  preview.
- Each MCP server becomes an MCP part, with the same checks as the switch to
  managed: environment values become variable names, and a server the
  catalog refuses is named with the reason.
- Permission rules can't be parts.
- Plugin instructions and servers stay with their plugin.
- A part with the same content already in the library isn't made again.
- Parts record their source as an import from project defaults.

## Later

- Plugins contribute attributed managed parts instead of writing project
  defaults (after #3262).
- At the end of the deprecation window, which the maintainer decides: remove
  the read-only section, the MCP inheritance and the wildcard fill from
  legacy commands.
