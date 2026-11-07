# Agent MCP configuration and chat preparation

Agent MCP editors resolve the agent's provider override, then the project provider,
then the app default. The IPC checks the project, agent id and worktree binding;
a shared folder requires an explicit agent id. Agents sharing a folder also share
that provider's local file. Agent saves use the existing transition reservation,
then recheck the provider, folder and managed setting immediately before writing.
The editor ignores read/save replies from a previous target or reload request.

The existing **Local overrides** choice determines the source for the next chat:

| Mode / source | Desired servers passed to the driver |
| --- | --- |
| Clubhouse Mode managed agent | Project `agentDefaults.mcpJson`, with agent wildcards |
| Unmanaged agent or Local overrides, local JSON file present | Entire effective-provider local `mcpServers` map |
| Unmanaged agent or Local overrides, local JSON file missing | Project `agentDefaults.mcpJson`, with agent wildcards |
| Local JSON explicitly contains `"mcpServers": {}` | No configured servers; inherited entries stay removed |
| Invalid local or inherited desired JSON | Actionable failure, without overwriting the invalid file or substituting an empty map |

The agent editor never updates project defaults or silently changes Local
overrides. Managed agents must explicitly turn on Local overrides in General
before saving agent-specific MCP configuration. Materialization preserves their
local MCP map, including during an explicit persona/instruction Apply.
Malformed local JSON remains visible for deliberate valid repair in the editor.

Chat reads its configured source before bridge injection. `clubhouse` is reserved
for the separately controlled live bridge; a configured entry cannot replace it.
The existing agent/project/global MCP enablement gates remain in force. A helper's
mandatory bridge does not grant it configured project or local servers while MCP
is off for that agent.

The sidebar's **configured** count summarizes configuration files and launch-wrapper
selections. It is not proof of delivery, transport support, authentication or a
connection. The map handed to a driver is a delivery boundary; the driver still
negotiates transports and reports connection state. For example, the Copilot SDK
driver reports each server's connection state, and a server it couldn't send.
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
