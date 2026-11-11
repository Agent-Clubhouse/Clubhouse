# Agent MCP configuration and chat preparation

Agent MCP editors resolve the agent's provider override, then the project provider,
then the app default. The IPC checks the project, agent id and worktree binding;
a shared folder requires an explicit agent id. Agents sharing a folder also share
that provider's local file. Agent saves use the existing transition reservation,
then recheck the provider and folder immediately before writing.
The editor ignores read/save replies from a previous target or reload request.

The servers passed to the driver for the next chat come from
`resolveAgentMcpServers` (`src/main/services/agent-mcp-servers.ts`), the same
resolution the terminal launch uses:

| Agent / source | Configured servers passed to the driver |
| --- | --- |
| Clubhouse-managed agent | Exactly the MCP server parts in its setup. Never the project defaults or a local file |
| Unmanaged agent, local JSON file present | Entire effective-provider local `mcpServers` map |
| Unmanaged agent, local JSON file missing | Project `agentDefaults.mcpJson`, with agent wildcards. Legacy and read-only since #3245; see [Project settings](project-settings.md) |
| Local JSON explicitly contains `"mcpServers": {}` | No configured servers; inherited entries stay removed |
| Project MCP JSON that isn't JSON (for example, it still has `@@If` blocks) | No project servers, with an `mcp_configuration` notice; the start goes ahead (D10 in `managed-agents.md`) |
| Invalid local JSON, or JSON that isn't a valid MCP configuration | Actionable failure, without overwriting the invalid file or substituting an empty map |

A managed agent's MCP servers are edited in the builder's MCP tab, not in the
JSON editor. The agent editor never updates project defaults. Malformed local
JSON remains visible for deliberate valid repair in the editor.

Chat reads its configured source before bridge injection. `clubhouse` is reserved
for the live bridge; a configured entry cannot replace it. One in the agent's own
file is dropped with a notice only when it is a user-authored, non-bridge server.
Bridge-shaped leftovers from older releases or crashes are ignored silently.
Bridge recognition requires `node` with a single argument whose filename is
exactly `clubhouse-mcp-bridge.js`; user servers that merely mention that name
in other arguments are not bridge entries.
JSON restore removes injected bridge entries while preserving user servers and
other settings, deleting a newly generated file if nothing remains.
The Clubhouse MCP always runs: every agent gets the bridge,
managed or not, helpers and quick agents included, and no app, project or agent
setting turns it off (D69 in `managed-agents.md`). Clubhouse Mode is gone (D68),
so nothing else decides which servers an agent gets.

The sidebar's **configured** count summarizes configuration files and launch-wrapper
selections. It is not proof of delivery, transport support, authentication or a
connection. The map handed to a driver is a delivery boundary; the driver still
negotiates transports and reports connection state. For example, the Copilot SDK
driver reports each server's connection state, and a server it couldn't send.
No save or configuration read probes a server.

## Codex local TOML limitation

The JSON editor does not read or write `.codex/config.toml`. Existing TOML helpers
serialize definitions and strip/inject individual sections; they are not a TOML
parser. So for an unmanaged Codex agent, Clubhouse delivers the project MCP JSON
defaults and doesn't pass the servers in the agent's own `.codex/config.toml`.

Codex reads that file itself, as its project config layer, but only for a
folder its user config trusts. Probed on Codex 0.163 with `config/read`: a
trusted folder's `mcp_servers` show in the effective config, and an untrusted
one's layer is disabled. So whether those servers reach a chat depends on
Codex's trust setting, which Clubhouse doesn't check.

Clubhouse writes the project MCP defaults into a new Codex worktree's
`.codex/config.toml` itself, and older versions wrote the bridge there. So
chat shows an `mcp_configuration` notice only when that file lists a server
that is neither the bridge nor one of the project servers chat delivers,
naming those servers (#2849). Chat preparation leaves the file's bytes,
including unrelated settings, untouched, and the live bridge goes to the
driver directly. A managed Codex agent gets its MCP parts as `-c` launch
flags in the terminal and session config in chat. Codex can still add a
trusted folder's project-layer servers on top of those.

The same JSON configuration rules apply on macOS, Linux and Windows. Validation
uses synthetic configuration and an in-memory driver, with no provider/server
processes, authentication, grants, scans or app restarts.
