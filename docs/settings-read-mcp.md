# Reading settings over MCP

Agents can look up settings with two read-only MCP tools, `list_settings` and `read_settings` (#2653). They are for answering questions like "why did this agent go to sleep after 30 minutes?" without dumping a config file. The rules live in `src/main/services/settings-read-service.ts`, which knows nothing about MCP. The tools only say who is asking.

Nothing here edits a setting. [Project admin and scoped edits](#design-only-project-admin-and-scoped-edits) is a proposal, and none of it is enabled.

## Tools

Both are global tools with no tool group, so every agent with Clubhouse MCP has them from its first tool list. Scope is decided on each call, so a CLI that never re-reads its tool list (`ignoresToolListChanged`) behaves the same, and a Dispatcher that gets turned off drops to its own scope on the next call.

### `list_settings`

Takes no arguments. Returns the sections and keys the caller can read now, as names only:

```json
{"sections":[{"section":"agent.idle","keys":["agent.idle.idle_sleep"]}]}
```

An agent with no saved config, such as a quick agent, sees no `agent.*`. An agent outside a registered project sees no `project.*`. Only the Dispatcher sees `app.system`.

### `read_settings`

| Argument | Meaning |
| --- | --- |
| `select` | Required. 1 to 40 sections or keys from `list_settings`. There is no read-everything form. |
| `agent_ids` | The agents to read for `agent.*` entries, up to 100. Defaults to the caller. |
| `project` | The project for `project.*` entries, by name, path or id. Defaults to the caller's own. For the Dispatcher it also limits where `agent_ids` are looked up, and it has no default. |
| `all_agents` | Every agent in `project`, leaving out disposed ones. Needs `project`. |
| `all_projects` | Every registered project. |
| `limit` | Targets per page, 1 to 25. Default 10. |
| `cursor` | `next_cursor` from the last page. |
| `detail` | Adds `stored` to each value, and `name` and `project_id` to each agent. |

```json
{"targets":[{"target":"agent","id":"durable_1","settings":{"agent.idle.idle_sleep":{"effective":30,"source":"app"}}}],"total":1}
```

Targets come in the order app, projects, agents.

## Limits

- A page holds at most 25 targets and 8,000 characters of JSON, whichever comes first.
- A page that stops early returns `next_cursor`, and targets past the stopping point aren't read.
- A single target too big for a page comes back with `truncated: true` and the keys it left out in `omitted`. Ask for those by key. The cursor moves past that target, so the omitted keys only come back if you ask.
- The cursor is an offset into the current target list. A project or agent added or removed between pages can shift it.
- The Dispatcher gets a per-target `error` of `not_found` or `unreadable` rather than losing the whole page.

## Who can read what

| Caller | Agents | Projects | App |
| --- | --- | --- | --- |
| An agent, helpers included | Itself | Its own | `app.defaults` |
| The running Dispatcher | Any | Any registered | `app.defaults`, `app.system` |

- A helper is an ordinary agent. It can't read its parent or its siblings, and an orchestrator can't read its helpers. See the design section for that.
- Refusals don't reveal what exists. Any other agent id gets the same fixed message, before any lookup, whether or not the agent is real. The same goes for projects.
- A Dispatcher-only key reads as `Unknown setting` to everyone else, the same as a key that doesn't exist.
- The Dispatcher's own folder isn't a registered project, so it has no `project.*` of its own. Its `agent.orchestration` keys come back in `not_applicable`, because they are locked.

## The allowlist

Only the keys below ever come out. Each is read by name from its source, never by spreading a config object, so a new setting doesn't appear until someone adds it here and to the catalog. A test pins this exact list, and another fails if a key looks sensitive.

| Section | Keys |
| --- | --- |
| `agent.identity` | `name`, `color`, `emoji`, `has_image` |
| `agent.cli` | `orchestrator`, `model`, `runtime` |
| `agent.persona` | `persona`, `mission` (ids) |
| `agent.access` | `free_agent_mode`, `permission_mode` |
| `agent.mcp` | `clubhouse_mcp`, `clubhouse_bridge`, `clubhouse_mode`, `mcp_ids` (ids) |
| `agent.idle` | `idle_sleep` |
| `agent.orchestration` | `orchestrate`, `access`, `control`, `max_helpers`, `cross_project_helpers`, `connect_to_dispatcher`, `auto_helpers` |
| `project.identity` | `name`, `display_name`, `color`, `emoji`, `has_image` |
| `project.defaults` | `orchestrator`, `persona`, `mission`, `free_agent_mode`, `profile_id`, `source_control_provider`, `default_mcps` |
| `project.modes` | `clubhouse_mode`, `mcp`, `permission_mode` |
| `app.defaults` | `idle_timeout_minutes`, `chat_enabled`, `provider_runtime`, `mcp_enabled`, `clubhouse_mode_enabled`, `permission_mode`, `global_helper_cap`, `enabled_orchestrators` |
| `app.system` | `dispatcher_enabled`, `experimental_chat`, `experimental_copilot_sdk`, `annex_server_enabled`, `annex_client_enabled` |

`app.defaults` is open to every agent because those values feed its own effective settings.

### Deliberately left out

- **Secrets and raw config:** `agents.json` and `settings.json` as a whole, `mcpJson`, `mcpConfigs`, launch wrappers, `commandPrefix`, profile env and contents, Annex pairing, TLS and device data, the CLI token, nonces, and the whole telemetry settings file.
- **Free text that can hold a credential:** build, test and lint commands, project instructions and permissions.
- **Session and work data:** session ids and history, `pendingTask`, handoff notes.
- **Editor, Goobers and security settings.** Nothing an agent needs to explain its own behavior. `allowLocalFileWebviews` lives behind the IPC layer, which this service shouldn't import.

`mission` is an id, the basename of `.clubhouse/missions/<id>.md`, and its text is never read. Like `persona`, it isn't validated when written, so a hand-edited `agents.json` could put any string there.

## Values and sources

Each value has `effective` and `source`, and `stored` with `detail`.

- `effective` comes from the resolvers the app itself uses: `buildAgentSettings`, `resolveOrchestrationPolicies`, `resolveMcpEnabled`, `resolvePersonaId` and so on. For an awake agent it's what the agent runs with now, and for a sleeping one it's what the next start uses.
- `stored` is what is saved at the level the key belongs to, or `null`.
- `applies: false` marks a setting with no effect on this target. Only chat agents idle-sleep, so `idle_sleep` on a terminal agent has it.
- `reason` is there when a value is derived off, and `stored` is what comes back when that clears. See [Derived off](#derived-off).

| `source` | Meaning |
| --- | --- |
| `agent` | Set on the agent. |
| `project` | From the project's `.clubhouse/settings.json`, or its entry in an app-wide project override. |
| `persona` | From the `orchestration:` front-matter of a persona. |
| `app` | The key is present in the app's settings file. |
| `default` | Nothing is saved, so a built-in value or a fixed rule decides. |
| `uncertain` | The app's settings file exists but can't be read or parsed, so nothing proves whether the value is saved. |

### What the sources can't tell you

- **`app` means saved, not chosen.** Presence in the file is what's checked, never the value, because the stores merge defaults in. The stores also save the whole object, so changing one setting on a page can save its neighbors at their default values, and those then read `app`.
- **A save still queued** shows on the next read. The file is checked, while `effective` comes from the store's memory.
- **`uncertain` still has an `effective`.** It's what the app is using: its in-memory value, or the default if it never loaded the file.
- **A preview-only experimental flag in a stable build** keeps `stored` and `source: app` when it's saved, and its `effective` is `false`. The flag is still in the file and comes back with Preview, but the build doesn't honour it. Compare `stored` with `detail` on.
- **A bridge isn't what an agent can call.** `clubhouse_bridge` says whether the bridge is injected at its start, and `clubhouse_mcp` what it can call. They only differ for a helper, whose bridge is always there, a fixed rule that reads `default`. With MCP off for it, `clubhouse_mcp` is off with `reason: helper_report_only`: its only working Clubhouse tool is `message_parent`.
- **Fixed rules read `default`.** A helper is never connected to the Dispatcher, whatever is saved. Compare `stored` with `detail` on.
- **A sleeping helper's `free_agent_mode`** is its saved value, before its orchestrator's ceiling applies at the next start. Awake, it's what the helper runs with.
- **`agent.cli.model`** reads `default` when the CLI picks. No CLI is asked which model that means, since that can spawn a process.
- **A saved Free Agent permission mode has no agent level**, so `agent.access.permission_mode` has a `stored` of `null`. See `project.modes` and `app.defaults` for the saved values.

### Derived off

Turning something off never rewrites what depends on it. The dependent value reads `effective: false` with a `reason`, and `source` is the level that decided, so it names what to change, not where the kept value lives. `stored` still shows the kept value.

| Key | `reason` | Means |
| --- | --- | --- |
| `orchestrate`, `cross_project_helpers`, `connect_to_dispatcher`, `auto_helpers` | `mcp_off` | Clubhouse MCP is off for this agent. `source` is the level that turned it off. |
| `connect_to_dispatcher` | `dispatcher_off` | MCP is on for this agent, and the Dispatcher's own switch is off. |
| `connect_to_dispatcher` | `mcp_off` | MCP is on for this agent through its own setting, and off at app level, so there's no Dispatcher to connect to. |
| `dispatcher_enabled` | `mcp_off` | Clubhouse MCP is off at app level: `mcp_enabled` false and the global Clubhouse mode off. A project or agent override doesn't keep it on. |
| `dispatcher_enabled` | `switch_off` | Its switch is saved off. |
| `dispatcher_enabled` | `classic_layout` | Nothing is saved and this session runs the classic layout. `source` is `default`. A saved `true` stays on there. |
| `dispatcher_enabled` | `experimental_off` | Nothing is saved on its switch, and `experimental-settings.json` has `dispatcher: false` from before the flag was removed. |
| `clubhouse_mcp`, `orchestrate`, `cross_project_helpers`, `auto_helpers` on a helper | `helper_report_only` | MCP is off for it by its own setting, its project's or the app's. It keeps `message_parent` and nothing else. |
| `clubhouse_mcp` on the Dispatcher | `mcp_off` | It can't start without MCP at app level, whatever its own override says. |

`dispatcher_enabled` with nothing saved reads `source: default`, `effective: true` in the new layout.

`effective` says what the settings give. A running agent keeps the connection it started with, so some of its tools outlast a change. [Running agents after MCP goes off](#running-agents-after-mcp-goes-off) says which.

## Running agents after MCP goes off

Turning MCP off stops no agent, and the bridge keeps running until a restart. It stops new tool calls. `clubhouse-mcp/mcp-call-gate.ts` answers at the entry of `callTool` and `getScopedToolList`, before anything else, by the caller's effective MCP: `isMcpEnabled(project, its own mcpOverride)`. So a CLI still holding an old tool list is refused the same way as one that re-read it, and calls already running finish.

| Caller | Tool list | New calls |
| --- | --- | --- |
| MCP on: its own override, its project's, the app's or Clubhouse mode | Everything it had | Everything it had |
| MCP off | Empty | All refused with `mcp_off`: orchestration, cross-project, Dispatcher, wires of every kind, group projects, browser, plugin, `call_wire_tool` and global tools |
| A helper with MCP off | `message_parent` | `message_parent` only |
| The Dispatcher with MCP off at app level | Empty | All refused. Its own override and project overrides don't count. It stays running and stoppable. |

When MCP is back, new calls work again at once in a session that started with the bridge, and the CLI is told to re-list. An agent that started with MCP off never got the config, so it needs a restart.

A helper's forced `clubhouseMcpOverride` still decides whether the bridge is injected. The gate decides what is callable, with its raw `mcpOverride`.

**Not gated:** inbound messages. The rule is about the caller, so an agent with MCP on can still message a running agent with MCP off, and a shoulder tap still reaches a running member. A dormant recipient isn't woken: the sender is told it is sleeping. The `clubhouse` CLI endpoint isn't an MCP tool and isn't gated: it changes a project's or agent's appearance and has no route to orchestration or other agents.

**Polling instructions stop too.** A member without MCP can't read the board, so it gets no polling start, and `nudge_polling` to it is refused. A start it missed is sent when MCP is back for it while it runs, or after its next start otherwise. Nothing is woken for this. A polling stop still goes out.

A running member whose session is polling gets one stop when it loses MCP. Polling is a loop the agent runs itself, so otherwise it keeps firing and being refused, spending a turn each time. Nothing restarts it by itself when MCP is back, because the app can't tell that loop from one someone has since ended. The group project shows the member as paused, with a Resume button that sends one start, in the same session only. So polling stays off after MCP returns until someone resumes it. A stopped, sleeping or replaced session gets none of this and isn't woken.

The app can't see inside the loop, so it decides who to stop and offer Resume by what it can see: this session was told to poll, and called `read_bulletin` in the last 5 minutes or was told within them. A start nobody has had yet, one the user asked for with MCP off or a new member's first, isn't a loop being restarted, so it still delivers when MCP is back or at the next handshake.

`test/mcp-off/mcp-off-revocation.test.ts` checks each row over HTTP.

## Reads change nothing

A read doesn't write, wake an agent, touch a tool gate or trigger a broadcast or refresh. Several existing reads aren't safe for this, so the service avoids them:

| Avoided | Why | Used instead |
| --- | --- | --- |
| `getDurableConfig`, `listDurable` | First load of a project can write `agents.json`, reassign copied ids, start a watcher and settle interrupted creations. | `peekDurableConfigs` |
| `projectStore.list` | Can migrate the store, quarantine a corrupt file and restore the backup, and creates the base folder. | `peekProjects` |
| `getOrchestrationPolicy` | Can close the tool gate. | `resolveOrchestrationPolicies` |
| `getModelOptions`, `checkAvailability` | Can spawn a CLI. | Not called |

`peekDurableConfigs` returns what's loaded, or parses the file and keeps nothing. So a project not loaded yet shows its records as they are on disk, before any repairs: a copied id still shows under its old value until the project loads. If two projects hold the same agent id, the Dispatcher gets the first match, starting with the project the agent runs in. Pass `project` to choose.

Settings stores still load a file into memory on first `get`, and `isPreviewEligible` logs at debug level. Neither changes anything on disk.

## Tool definitions

Every agent carries these definitions in its tool list, so they stay short: a test caps both together at 1,200 characters. Output is compact JSON for the same reason.

## Design only: project admin and scoped edits

**None of this is enabled.** There is no write path, no admin flag and no new authority. This is a proposal to argue with.

### Project admin

A named capability on a project, modeled on group project admins (`src/shared/group-project-admin.ts`): a list of agent ids in the project's settings.

- **Who gets it:** only by an explicit user action. It could become a default for orchestrators, as with group projects, but that default should be a separate decision, and a project should be able to turn it off.
- **Read scope:** the project's agents, and an orchestrator's own helpers in any project. That second part is the read that's deliberately missing today.
- **Limits:** it never reaches another project's other agents, `app.system`, or anything left out of the allowlist above. Secrets stay out for admins too.
- **Not inherited:** a helper never gets its parent's admin capability, the same way `connectToDispatcher` is always false on a helper.
- **Gate:** checked on each call inside the service, not by listing a tool. A CLI that keeps its first tool list must not keep authority that was taken away.

### Scoped edits

A separate tool, such as `update_settings`, and a separate allowlist.

- **Editable is not readable.** Each key opts in to editing on its own. The first candidates would be low-risk: `idle_sleep`, `color`, `emoji`. Never by default: `free_agent_mode`, `permission_mode`, `clubhouse_mcp`, `orchestrate`, `access`, `cross_project_helpers` and `connect_to_dispatcher`, since those raise an agent's own authority. They should keep needing the user.
- **Scope:** explicit target on every call, with no default target, so an agent can't change the wrong thing by leaving an argument out.
- **Same rules as the app:** go through the services the Settings page and `agent.update` use (`updateDurableConfig`, `setOrchestrationPolicy`), so locks like "sleep the agent first" and "settle its helpers first" still apply.
- **Stale writes:** take the `stored` value the caller read as a precondition, and refuse if it has changed.
- **Audit:** log each change with who asked, the target, the key, and old and new values, and show it to the user in the app, not only in a log file. Refusals should be logged too.
- **Permission boundary:** the user's own settings stay above any agent. A change to app-level settings stays out of scope even for an admin. Whether the Dispatcher may change them needs its own decision.
