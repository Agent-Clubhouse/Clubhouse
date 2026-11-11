# The Dispatcher in 1.0

What shipped under the Level Up epic (#3034), for people working on Clubhouse. The user-facing article is `src/renderer/features/help/content/agents-dispatcher.chrome.md`. "Dispatcher" is the working name; it lives in one constant, `DEFAULT_DISPATCHER_NAME` in `src/shared/dispatcher-name.ts`.

To the user it is one identity: one name, one chat, one set of settings. The debug view calls the agent that does its work the Dispatcher's controller. `src/main/services/dispatcher/dispatcher-copy.test.ts` fails on any string the app can show that names a coordinator, a second, hidden or background session, or the controller by its old name.

## On by default (#3053)

`resolveDispatcherEnablement` (`src/shared/dispatcher-types.ts`) decides, first match wins:

| Saved switch (`dispatcher-settings.json` `enabled`) | Old experimental `dispatcher` flag | Layout | Result |
|---|---|---|---|
| `false` | any | any | off, `switch_off` |
| `true` | any | any | on (the classic layout can turn it off, not on) |
| missing | `false` | any | off, `experimental_off` |
| missing | missing or `true` | new | **on** |
| missing | missing or `true` | classic | off, `classic_layout` |

- **Fresh installs** reach the last-but-one row: on. Startup creates its agent, writes its instructions and memory layout, and saves nothing to `dispatcher-settings.json`. First-run setup relies on that: a new install is told apart from an upgrade by a marker in its folder (`.clubhouse/created-with-setup.json`), not by settings.
- **Upgrades** with nothing saved are on too, and keep their agent, id, connections and links. Setup is shown once, prefilled.
- **An explicit off stays off:** a saved switch `false`, or a saved experimental `false` from before the flag graduated (#2831, maintainer decision: a saved graduated flag `false` is kept).
- Nothing default-on starts it. It runs when the user opens it, an agent messages it, or a check-in or upkeep Action wakes it.
- The switch is the first row of **Settings > Dispatcher**.

Tests: `dispatcher-service.test.ts` ("1.0 default"), `e2e/layout-default.spec.ts` (fresh install, nothing written), `e2e/dispatcher.spec.ts` (saved experimental false), `e2e/stable-mode.spec.ts` (Preview doesn't gate it).

## What it does

| Area | Issue | Where |
|---|---|---|
| Chat with zero tool noise, agents' news said once in the Dispatcher's voice (#3193), triage (now, next check-in, never), check-ins only when something changed, Clear chat | #3043 | `dispatcher-news.ts`, `dispatcher-triage.ts`, `dispatcher-clear-chat.ts`, `features/dispatcher/group-chat.ts` |
| Wake on message | #3037 | `clubhouse-mcp/tools/dispatcher-delivery.ts` |
| Memory: plain markdown index, agent pages, timeline, topics; old `notes/` sorted in once | #3038 | `dispatcher-memory*.ts` |
| Search over memory and transcripts | #3039 | `dispatcher-search.ts` |
| Hidden upkeep and check-in Actions tied to Behavior; usage split into conversations and background work | #3040 | `dispatcher-background*.ts`, `dispatcher-upkeep.ts`, `dispatcher-usage.ts` |
| Agent cards (`update_my_card`), asked on connect and setup change | #3041 | `dispatcher-agent-cards*.ts` |
| Subscriptions: agent-owned Actions that message the agent | #3042 | `shared/actions/subscription.ts`, `actions/engine.ts` |
| Auto minimum and maximum levels | #3044 | Auto mapping |
| Behavior: Light, Standard, Thorough; composer chip | #3045 | `shared/dispatcher-behavior.ts`, `features/dispatcher/BehaviorChip.tsx` |
| Choose models yourself: a provider, model, effort and context per job | #3191 | `shared/dispatcher-models.ts`, `dispatcher-models.ts`, `features/settings/DispatcherSettingsView.tsx` |
| Settings page with Connected agents and Forget everything | #3046 | `features/settings/DispatcherSettingsView.tsx`, `dispatcher-forget.ts`, `dispatcher-connected-agents.ts` |
| First-run setup, personality and presets, Try it out | #3047 | `dispatcher-setup.ts`, `shared/dispatcher-personality.ts`, `features/dispatcher/DispatcherSetup.tsx` |
| Teaching: intro, suggestions, "What else can you do?" from real grants | #3048 | `shared/dispatcher-teaching.ts` |
| An agent's Dispatcher card in Details | #3049 | `features/agents/details/DispatcherCard.tsx` |
| `project.add` (ask first) and the Dispatcher's default grants | #3050 | `shared/agent-grants.ts`, `shared/default-grants.ts` |
| Telemetry: usage split, memory health, triage outcomes | #3052 | `src/main/telemetry/dispatcher-telemetry.ts` |
| Phone: the same group chat | #3043 | `mobile-dispatcher.ts` |

**Memory upkeep freshness (part of #3218).** Mechanical link repairs preserve each page's modification time, so they neither trigger another agent review nor restart the 30-day staleness clock. The preserved timestamp is applied before the repaired file is published, so it cannot hide a later agent edit. Upkeep collects changed topics and agent notes after its repairs and saves a completion-time checkpoint. Actual agent edits still trigger review; only stale, unconfirmed, unreferenced topics are archived.

**Topic provenance (#3218).** Topics use plain header lines, not front matter: `Status:`, `Source:`, `Created:` and `Updated:` (ISO 8601 with a zone), then a blank line and body. Header order is flexible and extensions survive round trips. Existing undated pages need no migration: freshness uses a valid, nonfuture Updated date with a zone, otherwise mtime. Clubhouse topic writes preserve Created and stamp Updated. Important facts carry inline dated sources. The controller records contradictions explicitly as `Conflicting: YYYY-MM-DD ...` lines (the five newest dates, 500 characters each), with both claims and sources; there is no heuristic fact detector. Upkeep surfaces open conflicts instead of archiving them, and telemetry records only their page count.

**Memory access and versions (#3219).** Both the chat and controller have `read_memory`; only the controller has `write_memory`, with the `memory.write` grant on itself allowed by default. It replaces a whole `.md` page relative to memory, rejects escaping paths, symlink components and Windows-reserved names, protects agent cards, caps the index, and stamps topic dates. Protections apply after path normalization and regardless of folder casing; existing paths use their canonical filesystem spelling for access records and write locks. Conflict limits apply only to Notes on agent pages, never their Cards. History and archive are read only through the tool. Direct agent edits are discouraged, not blocked.

All Clubhouse page writers share `memoryWrite(page, text, reason)`, including cards, migration, timeline rollup, link repair and archive moves. `dispatcher/memory-access.json`, outside the searchable memory folder, keeps the last read/write, writer, bounded counters and file stamps/digests for up to 1,000 pages (most recently accessed first), never page text. Explicit reads, index loads and returned search hits count as access; internal upkeep scans do not. At upkeep, mtime and digest distinguish direct edits from the last Clubhouse write, including edits within one timestamp tick. Clubhouse-only card/repair writes do not trigger review or erase a pending controller/direct edit.

`memory/history/<page>/` keeps the latest five observed versions per page, including its current snapshot, for up to 30 days. Before replacing legacy bytes they are saved too; a direct edit can only retain an older version Clubhouse had already observed, not recover an unseen overwritten file. History follows archive/rename moves and is excluded from active page lists, search, staleness and health sizes. Upkeep removes expired/excess snapshots, and lists at most 15 neglected pages (the rest counted): neither read nor updated by the controller in 30 days, including old never-read pages. Recent reads or controller writes clear that neglect; without changes, problems or neglect, upkeep sends nothing. Telemetry counts neglected pages only.

## Agents' news in the chat (#3193)

What passes between the Dispatcher and an agent (progress, acknowledgements, an agent's questions to it) stays out of the chat. The agent's own chat keeps all of it. The chat shows only what is for the user:

- **A question or decision for the user** (`needs_user`) reaches the chat as a Clubhouse update, which the chat view doesn't show. The chat asks it in its own words, naming the agent, and that reply is the only time the user reads it. The user answers in the chat, which passes the answer on with `start_work` under the same request id. Nothing tells them to reply to the agent.
- **A result they asked for** (`answer`) shows the same way when it is for one of their requests (see Requests below). Anything else called an answer waits for the next check-in.
- **Routine progress** waits for the next check-in.
- No turn follows to react to news: the chat is never told that the user already read something.
- News that names an agent Clubhouse can't find (a name two projects share, a typo) is still that agent's news, under the name given.
- News is remembered as shown when it is sent. If it never reaches the chat (a wake that asks first, a chat shutting down, a start that fails), that is undone: it can be sent again, and the request it settled is put back. A question for the user also goes out as a notification that opens the chat. A chat turn that fails after the message arrived isn't detected.

## Routing (#3241)

Who does a piece of work, from the instructions and the `delegating-work` skill:

- **Project work** goes to the agent that owns the project, by card and project. Being awake, free, an orchestrator or recently busy doesn't make an agent the owner.
- **Machine setup** that no project owns yet is the Dispatcher's, done with its own command line at its own access level, and limited to: read-only checks (a tool and its version, a folder, a git remote), making a folder the user named, and cloning a repository the user gave into a new or empty folder, then adding it as a project with `add_project`. Never: project code, installs, sudo, global settings or credentials, deleting, running anything from a cloned repository, submodules unless asked, or cloning into Clubhouse's folders, a worktree or a non-empty folder.
- **Unsupported**: anything with no owner and no tool. The Dispatcher checks each part before it splits or promises the work, and says so with `needs_user` before starting.

## Requests (#3237, #3204, #3220)

Each `start_work` is a request with an id (`dispatcher-requests.ts`, kept in `dispatcher-requests.json`). The hand-off carries the id, and the Dispatcher reports under it with `tell_user`'s `request_id`.

- **Outcomes.** An answer for a request closes it. A question about one leaves it waiting on the user, and their answer goes back with `start_work` and the same `request_id`. Clubhouse follows the Dispatcher's turns (`dispatcher-request-outcomes.ts`): when the turn reading a request fails, is stopped, or the session ends before it is read, the request ends and the chat is told, with a retry offered. A request with no outcome times out: after 10 minutes when its turn ended and no agent was reached for it, otherwise after 2 hours.
- **Which request a report is for** (`matchRequest`): the id given; else, for an agent's news, the latest open request (under way or waiting on the user) that agent was messaged or woken for, so its progress after the request closed isn't an answer; else, for the Dispatcher's own words, the request its current turn is reading; else, for an answer, the one request under way when nothing else could be meant. A question from the Dispatcher in any other turn, such as a failed Action or a missing permission, answers no request.
- **Retries.** `start_work` with a `request_id` hands that request off again under the same id. The same words as a request under way aren't handed off twice; the same words as one that failed, was stopped or timed out retry it.
- **Steps done (#3241).** `tell_user`'s `done` notes the finished steps of a request on its record. A retry's hand-off lists them as already done, and the chat's failure update says which parts are done.
- **Attribution (#3241).** An answer in the Dispatcher's own words for a request it passed to exactly one agent since the last hand-off, which has messaged it since it was reached, is shown as that agent's news, and the tool result tells the Dispatcher so. When it can't be sure (several agents, an agent from an earlier attempt, or no message since it was reached), the words stay its own and the result reminds it to set `from`.
- **Status.** While any request is under way, the sidebar row and the pane header show Working, with "Working on your request", even when the chat is between turns or asleep (`dispatcherDot` in `agent-status.tsx`). The phone still shows the chat's own status.

The rewrite step that put agents' news into their own voice under their own name (#3043) is gone; the `clubhouse.dispatcher.news.rewrite` attributes stay on the triage event, always `none`.

A separate thread per agent was considered instead. It would keep the clutter out of the main chat but leave the user two places to watch, put questions that need them out of sight, and need new UI on desktop and phone. The fix in place keeps one conversation.

## What connections start with (#3214)

The maintainer set these defaults on 2026-11-09: "the only edit actions are send, and wake". A connection starts with reading, sending and wake on, and with `clear_agent` and `compact_agent` off, except where an agent already controls the other. They're in `AUTOMATIC_CONNECTION_SWITCHES` and `NEW_CONNECTION_SWITCHES` (`shared/connection-grants.ts`).

| Direction | Starts with |
|---|---|
| Orchestrator → its own helper | every tool on, wake included |
| Dispatcher → any agent | every tool on: clear, compact, wake, and sleep (its own, as before) |
| Helper → its orchestrator | send and wake; `clear_agent` and `compact_agent` off |
| Any agent → Dispatcher | send and wake; `clear_agent` and `compact_agent` off |
| Agent ↔ agent: an orchestrator's connections, `connect_agents`, and `connect_orchestrators` without `allow` | send and wake; `clear_agent` and `compact_agent` off |
| A canvas wire the user draws, Make two-way | send and wake; `clear_agent` and `compact_agent` off |

An explicit `allow` on `connect_orchestrators` or `set_connection_tools` still wins. Sleep isn't a connection switch: `sleep_agent` is offered only to the Dispatcher (its tool group), never to another agent, whatever a direction's switches say. Wake still needs the caller's `agent.wake` grant on top of the switch, so **Ask first** or **Off** on the permissions page holds it back (see Wake on a connection below). A helper's wire to its orchestrator offers no tool the helper's grants don't cover: a helper reaches its orchestrator with `message_parent`, so wake on that direction is a switch with nothing behind it.

Each source gives every direction it lists starting lists (`startingTools` on the binding: `disabledTools`, and `enabledTools` for wake). They apply whichever source bound the pair first, so a canvas wire with no list of its own doesn't leave the pair with every tool on. A saved direction always wins, an explicit everything-on included. When two sources give the same direction starting lists, the first one in the rebuild decides, so the helper source keeps an orchestrator's tools on its own helper. With nothing saved, the live binding carries the starting `enabledTools`, and wake reads from it (`localConnectionWakeOn` in `connection-grants-store.ts`, `localDirectionTools`). A wire drawn on the canvas is saved at once with wake on (`setDisabledTools` with `start`). A first change on the Connections card to a direction with nothing saved keeps the wake its source started it with.

**One-time pass** (`migrateAutomaticConnectionTools`, done marker `connection-defaults-3214-2026-11-09`), after a complete rebuild and after `migrateDispatcherLinkTools`. Only where nothing is saved, it gives:

- each direction a Clubhouse source lists (helper, Dispatcher and orchestrator links) the starting lists that source gave at its last collect. A start with every tool on isn't saved, since its binding already says that;
- each canvas wire with no list of its own that none of those lists the new-connection defaults (`listPairsWithoutTools`);
- each direction saved exactly as a new connection started before these defaults, wake on (`isOldNewConnectionDefault`): `clear_agent` and `compact_agent` off and nothing else, nothing turned on, no Make two-way link, both ends on this computer. That's a canvas wire drawn since #2969, or a Dispatcher link #3216's pass or `connect_orchestrators` saved. Who set it (`setBy`) is kept. The maintainer ruled it isn't a user choice, since Wake it didn't exist when it was saved. It's checked again under the store's lock (`runConnectionMigration`'s `replaceIf`), so a direction changed meanwhile stays.

It never touches any other saved direction: one with a different list, an explicit everything-on, something turned on, a Make two-way link, or an end on another computer. Those keep wake as saved. It waits while any source can't be read or the file is a newer build's. Until it has run, starting lists apply live only. After it, a direction's starting lists are saved the first time a rebuild finds nothing saved for it (`fillConnectionTools`, decided under the store's lock). When the file is a newer build's, nothing is saved and the warning is logged once per process. The marker was renamed from an earlier draft's `automatic-connection-defaults-3214`, so a build that ran that draft runs this pass too.

## Links between agents (#3215, #3248)

The Dispatcher can link two agents connected to it so they reach each other directly, whether or not either orchestrates (#3248), with only the tools the user wants on each direction. `connect_orchestrators` takes `allow` (and `allow_back` for the way back) from the connection switches: `get_status`, `read_output`, `check_connectivity`, `send_message`, `send_file`, `clear_agent`, `compact_agent`, `wake_agent`. With none named, a new link reads, messages and wakes, with clear and compact off. `set_connection_tools` changes the tools on a link it made, and refuses a direction whose tools are the user's. Both, and every link in `list_orchestrator_controls`, read each direction back (`tools.allowed`, `tools.disabled`, `tools_yours`), so it can check the link is what the user asked for. Sleep is never a connection tool. Details: `docs/dispatcher-orchestrator-controls.md`.

**Wake on a connection.** `wake_agent` used to be the Dispatcher's alone on this computer. It is now also a per-direction switch, **Wake it**, on every connection between two agents here. It's on for a new connection (the 2026-11-09 defaults above) and off for a direction saved before it existed (`enabledTools` on the direction, `localWakeOn` in `shared/connection-grants.ts`). With it on, the sender is offered `wake_agent` for that target while it sleeps, beside `get_status` (`wakeOffered` in `tool-registry.ts`), and a sleeping target's hints point at `wake_agent` only for a caller that can call it (`canCallWake`). The Connections card has no Wake it on a wire with the Dispatcher or a helper's link with its orchestrator. The call still needs the grant: every agent has `agent.wake` on `{ kind: 'connected', wakeOn: true }`, shown on the permissions page as "Connected agents with Wake it on", so Allow, Ask first and Off there apply on top of the switch. Off on either one stops it. The Dispatcher is unchanged: it is offered `wake_agent` on every connected agent whatever the switch says, as before, and keeps `agent.wake` on every connected agent. Across machines, wake keeps its own switch (D232) and stays the Dispatcher's.

## Debug view (#3188)

**Settings > Experimental > Dispatcher debug view** (flag `dispatcherDebug`, preview-only) changes only what is shown, never what the Dispatcher does. Off is exactly the normal view.

- **Controller row.** A row named "Dispatcher controller" under the Dispatcher's opens the controller's chat (`state.agentId`) in the Dispatcher's view, read-only: its transcript and live events, everything shown, no composer or controls (`DispatcherWorkView.tsx`). The agent isn't loaded into the agent store, so nothing else (canvas, palette, Needs you) sees it.
- **Hidden content.** The Dispatcher's chat shows every item as it is, and marks each block the group chat would hide ("Debug · hidden from the chat": tool calls, thoughts, normal turn footers, subagent work, Clubhouse updates including agents' raw news) or clean ("Debug · raw, the chat shows it cleaned"). The marks come from `groupChatDebugMarks` in `features/dispatcher/group-chat.ts`, so they follow the same rules. Desktop only: a phone still gets the filtered chat.

The switch is read at startup and updated by the Experimental page as it saves, so no restart is needed. Its copy calls the agent the controller, which `dispatcher-copy.test.ts` allows without an exception.

## Its name

The saved name, cleaned, or `DEFAULT_DISPATCHER_NAME` when it's blank, comes from `dispatcherDisplayName()` in `dispatcher-service.ts`. Its wires to connected agents carry it (`dispatcher-wire-source.ts`), so agents see the name the user chose, and so do hand-offs and the agent-card requests. A rename changes the wires' signature; the state broadcast makes the wire watcher rebuild, and the bindings are relabelled in place, so no wire drops. Its agent is still created under the working name until setup or Settings renames it.

## Choose models yourself (#3191)

A switch under Behavior in Settings > Dispatcher. Off, Behavior gives both agents their models from the Auto mapping, as before. On, each agent runs the user's pick, saved in `dispatcher-settings.json` under `models` (`byHand`, `chat`, `work`; each pick is `provider`, `model`, `effort`, `contextWindow`). The UI calls the jobs "Talking with you" (`chat`) and "Working in the background" (`work`); the copy test allows that label because it names no session.

- **Where it applies.** `applyBehavior` hands off to `applyChosenModels` while the switch is on, so every moment that gave Behavior's models (before each start, a level change, an Auto mapping change) gives the picks instead, and Behavior never overwrites them. Behavior still sets the check-in and upkeep frequencies.
- **Records follow the picks.** A pick is written to its agent's record (`updateDurableConfig`, which checks a context choice and drops a session from another CLI). Settings is the source of truth: an edit to a record from elsewhere is put back at the next start, which writes the instructions for the CLI it starts on. A saved context the model no longer offers is dropped from the record and the pick, and logged; the rest of the pick applies. A phone's CLI, model or context edit for the Dispatcher is saved as the `chat` pick instead, checked before anything else is written. A guided provider change (the phone's `agent.providerChange`, the `change_provider` tool) is refused with `dispatcher_models_by_hand` while the switch is on.
- **Order.** Every change reads and merges the saved picks inside the service's queue, so two changes in a row both land.
- **When.** A model or effort change on the same provider switches a running session where its CLI allows (`switchRunningModel`), queued after the save and reading the pick as saved then; a provider or context change, or the CLI's default model, applies at the next start. Behavior's models switch a running session only on the provider they're for too. The start path takes the pick's provider from `prepareDispatcherSessionStart`, and drops the session it would resume whenever applying the pick moved its record to another CLI.
- **Different providers.** While it's on, the identity mirror doesn't copy `orchestrator` or `contextWindow` between the records, so each runs on its own CLI.
- **Turning on** saves the provider and context the agents run on (`modelsBefore` in `dispatcher-settings.json`) and seeds each pick from what its agent runs now, so it changes nothing by itself; turning it back on with earlier picks switches a running session on the same provider. **Turning off** (`leaveModelsByHand`) puts both records back on that saved provider and context, so no context from a pick stays hidden, then Behavior applies. Without a saved one, both go to the provider "Runs on" shows with no context. The picks are kept for next time. **Setup** turns it off the same way, since setup picks one provider and a Behavior.

## Forget everything

Clears `memory/` (including `memory/archive/` and `memory/history/`), `dispatcher/memory-access.json`, an unsorted `notes/`, every `notes-archive*`, and news held for the next check-in, then makes a fresh index and rewrites its instructions. It never touches its agents, connections, links, permissions, Actions, Behavior, personality, usage history or its chat. Clear chat is the separate way to start the chat over.

## Files

All under the Clubhouse base folder (`~/.clubhouse`, or `.clubhouse-dev` in development) unless noted:

| File | Holds | Cleared by Forget everything |
|---|---|---|
| `dispatcher/memory/` | memory | yes |
| `dispatcher/memory-access.json` | bounded read/write metadata, no page text | yes |
| `dispatcher/notes-archive*/` | notes from before memory | yes |
| `dispatcher-news.json` | held news, recently shown | held news only |
| `dispatcher-requests.json` | the user's requests from the last week and how each ended | no |
| `dispatcher-agent-cards.json` | when each agent was asked for its card | no (a missing page asks again) |
| `dispatcher-usage.json` | 31 days of usage, conversations and background work | no |
| `dispatcher-upkeep.json` | when upkeep last ran | no |
| `dispatcher-settings.json` (app settings folder) | switch, Behavior, chosen models and what they replaced, personality, setup state | no |
