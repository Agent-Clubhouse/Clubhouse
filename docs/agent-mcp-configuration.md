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

## Clubhouse tool effect hints

The bridge publishes explicit `readOnlyHint`, `destructiveHint` and
`openWorldHint` annotations with each built-in tool in `tools/list`, for both
HTTP and stdio clients. The reviewed catalog lives in `clubhouse-mcp/tool-registry.ts`;
the annotation inventory test registers the same catalog as startup, including
helper and group-project tools, and fails if a new tool has no classification.

Reads are distinguished from writes, not inferred from names or grants.
For example, `hand_off` records a receipt without disposing anything, whereas
`dispose_helper`, `clear_agent`, `clear_topic` and `delete_messages` are destructive.
Mixed tools describe their possible effects: arbitrary browser operations,
reset/compaction, force-capable sleep, fresh restart and delegated actions are
not advertised as harmless reads. Browser tools, live provider model/preset
queries, and helper creation with model validation are open-world;
Clubhouse-internal tools are closed-world. `add_project` registers an existing
local folder and may update its `.gitignore`; it does not clone a repository.
Contributed plugin tools and the generic wire-tool dispatcher conservatively advertise
possible writes, destruction and open-world access.

These are client-facing descriptions, not authorization. Tool-group, wire,
role, grant and user-approval checks still run on every call. An annotation
does not grant access or change any provider's approval policy.

The connection editor reads `getConnectionToolCatalog` for registered suffixes
and base descriptions, including tools currently gated by role, group or grant.
It does not depend on a running client or target; asleep/busy state, custom wire
guidance and direction switches do not alter the catalog. A tool requiring
approval stays available as in normal listing. A plugin without a registered
catalog is explicitly unavailable rather than an apparently empty tool list.
Catalog availability is not authorization: calls still enforce the saved
direction switches and all existing checks.

## Opening connection targets

**Open** navigates to the target, independently of **Edit** and source-aware
**Remove**. Agents are resolved by their actual ID across registered projects,
not by their name or whether their rail card has loaded. An unavailable target
explains what to restore or repair and offers **Retry Open**.

Group projects open their persisted Canvas representation and reveal its actual
project node, including on an unvisited Canvas. Multiple representations offer
a chooser labeled by Home/project, Canvas and node identities; no representation
explains that no owning Canvas is available. Loaded Canvas edits override saved
placement, and incomplete or stale lookups are reported rather than guessed.
Browser and terminal widgets use their existing Canvas route; plugins open an
enabled contributed tab when one exists. Unsupported targets have a disabled
Open action with an accessible explanation.

Open does not create Canvases/projects, reconnect inactive wires, or change
bindings, membership, grants or policy. Canvas navigation uses read-only lookup
and validated hydration rather than a new-board/recovery path. Normal manual
Canvas opening, subsequent explicit edits and runtime wake reconciliation keep
their existing behavior.

## Directional connection guidance

The Connections card's **Edit** and Canvas wire editors share the same
directional editor: connection switches, ownership/removal sources, and guidance.
Edit also inspects browser, terminal, group-project and plugin rows without
requiring a Canvas placement. Guidance writability comes from the backend
ownership snapshot, not the row's helper or target kind. Plugin and
membership-managed guidance remains read-only with its owning-source reason.
Source-read failures remain visible and retryable; they do not hide Edit.
Suspended connections without an active binding show saved guidance read-only
when the backend can prove their durable source, direction and endpoint kind.
No binding or session is created to inspect them. Unreadable, removed, ambiguous
or stale sources produce an explicit inspection error instead of granting access
from a saved guidance entry alone. Editing and description previews still require
an active binding. Any unsaved draft is retained separately from the saved text
and becomes editable again after reconnecting. No running tool client is needed
to inspect guidance, even when its sender or target sleeps.
Configured automatic Dispatcher directions also appear on the Connections card
while the Dispatcher is off, clearly marked suspended and not connected. These
read-only inspection rows do not enable connection tools, Wake it or Make two-way.
Their source's existing Remove action still requires confirmation before turning
off Connect to Dispatcher. Inspection rejects corrupt source files without
repairing, restoring or quarantining them.
Saving guidance changes only the selected sender-to-receiver direction. The
explicit **Copy guidance to reverse draft** action copies text, not permissions,
and still requires saving that reverse direction separately.

The default applies to each registered tool unless a nonempty per-tool override
replaces it. Clearing an override restores the default; saved overrides for
temporarily unavailable tools remain editable and retained. Description preview
uses the registered base descriptions and the same sanitization and replacement
rules as the runtime tool list. An unavailable catalog is reported, not replaced
with a hardcoded list. Default and saved per-tool guidance remain editable when
the catalog is unavailable or its request fails; only discovery and description
preview require the tool index.
Search filters registered tool suffixes and base descriptions without changing
the selected tool or discarding saved overrides. **Configured overrides** lists
nonempty per-tool replacements, including currently gated or absent tools,
independently of the search.

User guidance is saved atomically in `connection-instructions.json`, keyed by
canonical direction and target kind, independently of Canvas placement. Original
source text is retained in its original stores and shown with provenance.
Canvas provenance includes stable project/store identities, not just display
names or private filesystem paths. Replacing effective source guidance requires
explicit confirmation. Unreadable sources and membership-managed federation
directions cannot be edited.
Concurrent/stale saves fail explicitly, leaving the draft available; reloading
sources retains unsaved text for review and another explicit save. Empty saved
guidance deliberately suppresses original source guidance. Source restoration
and later Canvas hydration cannot overwrite the saved directional choice.
Saving does not restart a session or change any permission or reverse direction.
Save feedback distinguishes updated server definitions from descriptions loaded
by the sender's client. A CLI known to keep its first tool list requires a
session restart. For other runtimes, including native chat, client refresh is
not confirmed: reload tools or restart the sender's session to ensure it loads
the saved descriptions. A tool-list change notification or connected-server
status alone is not proof of client-visible refresh.

Reads and source restoration use only committed guidance, never an in-flight
save's cache. Malformed files and duplicate direction records fail closed and
are not overwritten. Saves serialize source inspection through disk commit and
live publication, rechecking binding identity and source ownership. If ownership
or sources change during an otherwise successful disk commit, the save reports
that it was committed but not applied to the live direction and requires a
reload. Membership-owned directions never hydrate ordinary-direction overrides.

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
