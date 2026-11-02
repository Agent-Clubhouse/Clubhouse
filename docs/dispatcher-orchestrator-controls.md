# Dispatcher controls over orchestrators

The Dispatcher can change two helper settings on a connected orchestrator, and link connected orchestrators directly (#2661). The rules live in `src/main/services/dispatcher-controls.ts`, and the links in `dispatcher-connections.ts`. This is the Dispatcher's first write authority beyond appearance, so it is narrow on purpose.

## Who and what

The tools are in the `dispatcher` tool group: only the running Dispatcher sees or can call them, even with a stale tool list. The rules check the caller again. Nothing here is exposed over IPC, Annex or the CLI.

A target must be a connected orchestrator now: not disposed, not a helper, not the Dispatcher, with `orchestrate` and `connectToDispatcher` both resolving true. Clubhouse MCP being off resolves both false.

## Tools

Agents are named by id, from `list_agents`. Any argument not listed here is refused by name.

### `set_orchestrator_helpers`

| Argument | Meaning |
| --- | --- |
| `agent_id` | Required. |
| `cross_project_helpers` | True or false. |
| `max_helpers` | Whole number from 1 to the ceiling: the lower of 100 and the app-wide helper cap. |

At least one setting is required. The change goes through `setOrchestrationPolicy`, under its per-agent lock, where the target is checked again.

No helper is stopped or settled. A cap below the live count returns `helpersOverCap`, and new starts are refused until the count drops. Turning cross-project helpers off returns `crossProjectHelpersKept` when some are running elsewhere. Saving goes through the same gate handling as the settings UI, so it can open the tool gate of a running agent whose saved policy already says orchestrate.

The ceiling is enforced in this tool only. `setOrchestrationPolicy` itself still accepts up to 100, as it did for its other callers.

### `connect_orchestrators` and `disconnect_orchestrators`

| Argument | Meaning |
| --- | --- |
| `from` | Required. The orchestrator that gets the tools. |
| `to` | Required. The orchestrator it reaches. |
| `two_way` | Both directions, all or nothing. Default false. |

Limits: 50 links in total and 10 outgoing per orchestrator, since each wire adds tools to an agent's list.

Connecting a pair already bound some other way is refused, so the Dispatcher never claims a wire it didn't make. Connecting a pair it already made is a successful no-op. Disconnecting only acts on pairs in its store.

### `list_orchestrator_controls`

| Argument | Meaning |
| --- | --- |
| `agent_id` | Just this orchestrator and its links. |
| `limit` | Orchestrators per page, 1 to 25. Default 10. |
| `cursor` | `next_cursor` from the last page. |
| `audit` | Newest audit rows to add, 0 to 50. Default 0. |

`links` holds only what is in the Dispatcher's store. A wire it didn't make is never listed. A pair the user also drew has `also_user_wire: true`, and that wire stays whatever happens to the link.

## Refusals

| Case | Code |
| --- | --- |
| Not the Dispatcher | The registry's group gate, or `not_dispatcher` |
| `orchestrate`, `connectToDispatcher`, `access`, `control` or any other extra argument | `unknown_field` |
| The Dispatcher as an end or a target, which covers disconnecting a target from it | `dispatcher_wire` |
| A helper | `helper` |
| A disposed or unknown agent, or one that isn't a connected orchestrator | `not_connected_orchestrator` |
| Disconnecting a link the Dispatcher didn't make | `not_dispatcher_owned` |
| Connecting a pair already bound some other way | `already_linked` |
| Connecting a pair the user removed | `removed_by_user` |
| `max_helpers` outside its range | `max_helpers_out_of_range` |
| Past a link limit | `link_limit` |

A refused call changes nothing. With `two_way`, a refusal for one direction leaves both as they were.

## Provenance

`dispatcher-connections.json` under the Clubhouse base dir holds one entry per direction: both ends, each end's project, `createdAt` and `createdBy`. It isn't in the Dispatcher's folder, because that is its working directory. That keeps it out of the way of ordinary file tools. It is not a security boundary against an agent at bypass level, which can write any file.

A restart rebuilds stored pairs through a pruning binding source, registered after the canvas source. A pair the user also drew restores from the canvas first, so the binding stays the user's, and disconnecting it drops only the Dispatcher's entry.

## Link status

| Status | Meaning | Binding | Entry |
| --- | --- | --- | --- |
| `active` | Both ends are connected orchestrators. | Up | Kept |
| `suspended` | An end stopped qualifying, or the Dispatcher is off. | Removed | Kept |
| `unverified` | An end's project can't be read. | Left as it is | Kept |
| `gone` | An end was disposed or deleted, became a helper, or its project was unregistered. | Removed | Dropped for good |

A suspended link has a `reason`: `dispatcher_off`, `mcp_off`, `orchestration_off` or `not_connected_to_dispatcher`. It comes back by itself when the reason ends. So that this is never unseen, readback and the Connections card both show suspended links, and the user can remove one from the card.

## User removal

The Connections card marks the Dispatcher's links and lets the user remove them. A removal drops the entry and writes a tombstone to the same store, so the pair stays removed across restarts and the Dispatcher going off and on. It ends only when the user draws that pair. A tombstone covers one direction, and is dropped once an end is gone for good.

Limit: tombstones only cover pairs in this store. Removing a wire the Dispatcher never made is remembered for that session only, as for any other wire, so it could connect that pair in a later session.

If writing the tombstone fails, the failure is logged and the pair stays removed for that session, but a restart would bring the entry back.

## Audit

`dispatcher-audit.jsonl` under the Clubhouse base dir, one row per write call, refusals included:

```json
{"ts":"2026-11-01T12:00:00.000Z","tool":"set_orchestrator_helpers","actorId":"durable_1","targets":["durable_2"],"requested":{"fields":["max_helpers"],"max_helpers":3},"outcome":"ok","before":{"crossProjectHelpers":false,"maxHelpers":5},"after":{"crossProjectHelpers":false,"maxHelpers":3}}
```

Rows hold allowlisted values only, and ids the caller supplied are cut to 100 characters. At 1 MB the file moves to `.1`, replacing the older one.

Two refusals happen before the rules run, so they leave no row: the registry's group gate for other agents, and its check of an argument's type. Those show in tool-call telemetry. If a row can't be written after a successful change, the change stands and the result has `audit_warning`.
