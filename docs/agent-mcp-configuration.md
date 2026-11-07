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
| Unmanaged agent, local JSON file missing | Project `agentDefaults.mcpJson`, with agent wildcards |
| Local JSON explicitly contains `"mcpServers": {}` | No configured servers; inherited entries stay removed |
| Project MCP JSON that isn't JSON (for example, it still has `@@If` blocks) | No project servers, with an `mcp_configuration` notice; the start goes ahead (D10 in `managed-agents.md`) |
| Invalid local JSON, or JSON that isn't a valid MCP configuration | Actionable failure, without overwriting the invalid file or substituting an empty map |

A managed agent's MCP servers are edited in the builder's MCP tab, not in the
JSON editor. The agent editor never updates project defaults. Malformed local
JSON remains visible for deliberate valid repair in the editor.

Chat reads its configured source before bridge injection. `clubhouse` is reserved
for the live bridge; a configured entry cannot replace it. One in the agent's own
file is dropped with a notice. The Clubhouse MCP always runs: every agent gets the bridge,
managed or not, helpers and quick agents included, and no app, project or agent
setting turns it off (D69 in `managed-agents.md`). Clubhouse Mode is gone (D68),
so nothing else decides which servers an agent gets.

The sidebar's **configured** count summarizes configuration files and launch-wrapper
selections. It is not proof of delivery, transport support, authentication or a
connection. The map handed to a driver is a delivery boundary; the driver still
negotiates transports and reports connection state. For example, the ACP driver
already reports unsupported stdio servers explicitly when the agent refuses them.
No save or configuration read probes a server.

## Codex local TOML limitation

The JSON editor does not read or write `.codex/config.toml`. Existing TOML helpers
serialize definitions and strip/inject individual sections; they are not a TOML
parser. Chat therefore retains canonical project JSON delivery for Codex and emits
a visible notice that local TOML servers are not delivered by this path. Chat
preparation leaves the local TOML bytes, including unrelated settings, untouched;
the live bridge is supplied directly to the driver. This change does not implement
all-provider local MCP editing or migrate existing files.

The same JSON configuration rules apply on macOS, Linux and Windows. Validation
uses synthetic configuration and an in-memory driver, with no provider/server
processes, authentication, grants, scans or app restarts.
