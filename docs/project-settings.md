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
  `agent.create`, another computer over Annex, or the plugin API (the Canvas
  new agent included). The MCP, phone and Annex results carry
  `legacyDefaults: "not_copied"` when the project has legacy values; the
  plugin API's result doesn't change.

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

For a new agent the preview reads the files its worktree will start with:
what git checks out for its branch (the existing `<name>/standby` branch, or
the project's HEAD). A repository that tracks its own `CLAUDE.md`,
`AGENTS.md`, `.mcp.json` or `.codex/config.toml` keeps them: the copy adds to
them exactly as previewed.

**Changed from before #3245.** The old automatic snapshot overwrote the new
worktree's instructions and MCP file with the project's defaults, replacing
any committed copy, and replaced the permission rules in its local settings.
The copy now adds to what's there and never replaces a tracked file. Its
permission rules are kept and the legacy ones added after them.

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
- Plugin instructions and servers become that plugin's parts (see below), as
  if the plugin had written them since #3245. The plugin's next write updates
  them.
- A part with the same content already in the library isn't made again.
- Parts record their source as an import from project defaults.

## Plugin contributions

A plugin's `agentConfig` API no longer writes the project's legacy defaults:

| Call | Since #3245 |
|------|-------------|
| `appendInstructions` | Creates or updates the block part "<project>: <plugin> instructions" |
| `injectMcpServers` | One MCP server part per server, "<project>: <plugin> <server>"; a server left out of the next call is removed. Env values become names; a refused server is logged |
| `removeInstructionAppend`, `removeMcpServers` | Remove those parts; agents that use one keep their own copy |
| `addPermissionAllowRules`, `addPermissionDenyRules` | Do nothing, with a warning in the plugin's log once. Each CLI has its own rule syntax |
| `removePermissionRules`, `getPermissionRules` | Still remove and read rules saved before |
| Uninstall | Removes the plugin's parts for the project, as above |

The parts are library parts attributed to the plugin ("by the <plugin>
plugin", and in the description), with the catalog source
`{ kind: 'plugin', pluginId, projectId, key }`. A person adds them to an
agent or template. A plain agent doesn't get them; it uses its own files.

A plugin's write also clears what it had saved in the legacy defaults for the
same thing, since the part replaces it. Only that plugin's: a saved server is
matched to its plugin by the longest known plugin id (built-in, installed, or
named in the saved defaults), so `foo` writing never clears `foo-bar`'s
`plugin-foo-bar-*` servers. A server the catalog refuses keeps its saved copy,
since no part replaces it.

**Existing plain agents lose a plugin's MCP servers at their next start after
the plugin writes them.** Until then they got them from the project's legacy
MCP servers; afterwards those are the plugin's parts, which only agents that
list them get. The same goes for a plugin's instructions in agents created
with the legacy copy from then on. The settings page says which plugins now
add parts ("<plugin> now adds its instructions and servers as parts"), and so
does each part's description in the library.

A part's name follows a renamed project at the plugin's next write. Until then, its saved items stay
read-only like the rest, and Import as parts turns them into the plugin's
parts without changing the saved values. The plugin API version is
unchanged: every method keeps its signature.

## Later

- Not scheduled. The deprecation window is longer than one beta. A later
  change may remove the read-only section, the MCP inheritance and the
  wildcard fill from legacy commands, but saved legacy values are never
  deleted: they stay in the project's settings file.
