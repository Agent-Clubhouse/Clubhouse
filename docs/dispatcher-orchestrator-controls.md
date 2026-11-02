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

`unconfirmed_removals`, when present, lists links the user removed that the store hasn't taken yet. `saved` is false when a restart could lose the removal. See [User removal](#user-removal).

## Refusals

| Case | Code |
| --- | --- |
| Not the Dispatcher | The registry's group gate (no audit row), or `not_dispatcher` |
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
| `suspended` | An end stopped qualifying, the Dispatcher is off, or the store's folder takes no writes. | Removed | Kept |
| `unverified` | An end's project can't be read. | Left as it is | Kept |
| `gone` | An end was disposed or deleted, became a helper, or its project was unregistered. | Removed | Dropped for good |

A suspended link has a `reason`: `dispatcher_off`, `store_unwritable`, `mcp_off`, `orchestration_off` or `not_connected_to_dispatcher`. It comes back by itself when the reason ends. So that this is never unseen, readback and the Connections card both show suspended links, and the user can remove one from the card.

## User removal

The Connections card marks the Dispatcher's links and lets the user remove them. A removal drops the entry and writes a tombstone to the same store, so the pair stays removed across restarts and the Dispatcher going off and on. It ends only when the user draws that pair. A tombstone covers one direction, and is dropped once an end is gone for good.

Limit: tombstones only cover pairs in this store. Removing a wire the Dispatcher never made is remembered for that session only, as for any other wire, so it could connect that pair in a later session.

### When the removal can't be written

The store keeps its stale entry if it can't be written, or read, at that moment: a full disk, a permissions problem, or a store from a newer Clubhouse. So the removal stays pending, and a stale entry can't restore:

1. The removal goes to `dispatcher-connections.pending-removals.json`, beside the store. Every read of the store applies that file first, so restores, readback and the tools all see the pair as removed and tombstoned. The next successful save carries it in and deletes the file. A retry runs every 30 seconds, on any change the store watches, and at startup. A store from a newer Clubhouse is never rewritten, so there the file just stays.
2. If that file can't be written either, the removal holds in memory for the session and keeps retrying. The user gets an error toast saying the link could come back, and readback shows `saved: false`.
3. A session that finds saved links in a folder that takes no writes restores none of them, since the last session may have had no way to record a removal. They read as suspended with `store_unwritable`, and come back by themselves once a write lands.
4. A pending file that can't be parsed fails closed. No link restores and the link tools return an error until a person moves the file away. Nothing overwrites it.

None of this touches the user's own wires. A pair the user also drew restores from the canvas as usual, stays bound while the store is suspended, and only the Dispatcher's entry is dropped.

Drawing a pair while its removal can't be saved leaves the removal in place, so the Dispatcher stays refused for that pair until the user draws it again with the store working. That is the safe side, and the user's wire isn't affected.

Limit: step 2 is the only case with no record past the session. If nothing in the folder could be written until the app ended, and writes work again at the next launch, nothing is left to say the link was removed, so it returns. That needs a failure lasting from the removal through every retry that then clears by the next launch, and it is the case the toast warns about. Closing it would need evidence written before the failure, such as suspending every link after any unclean exit. That was left out because a crash would then take down every link.

## Audit

`dispatcher-audit.jsonl` under the Clubhouse base dir, with one row per write call that reaches the service, including the service's own refusals:

```json
{"ts":"2026-11-01T12:00:00.000Z","tool":"set_orchestrator_helpers","actorId":"durable_1","targets":["durable_2"],"requested":{"fields":["max_helpers"],"max_helpers":3},"outcome":"ok","before":{"crossProjectHelpers":false,"maxHelpers":5},"after":{"crossProjectHelpers":false,"maxHelpers":3}}
```

Rows hold allowlisted values only, and ids the caller supplied are cut to 100 characters. At 1 MB the file moves to `.1`, replacing the older one.

Every code in [Refusals](#refusals) comes from the service and is audited, apart from the registry row below.

Two refusals happen in the tool registry, before the service runs, so they leave no row: the group gate for other agents, and the check of an argument's type. Those show only in tool-call telemetry. This is an accepted limit. The same caller reaching the service directly is refused with `not_dispatcher`, and that is audited.

If a row can't be written after a successful change, the change stands and the result has `audit_warning`.
