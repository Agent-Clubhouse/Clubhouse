# The Dispatcher in 1.0

What shipped under the Level Up epic (#3034), for people working on Clubhouse. The user-facing article is `src/renderer/features/help/content/agents-dispatcher.chrome.md`. "Dispatcher" is the working name; it lives in one constant, `DEFAULT_DISPATCHER_NAME` in `src/shared/dispatcher-name.ts`.

To the user it is one identity: one name, one chat, one set of settings. No UI text, help page, status line or instructions file may say how the work is divided inside it. `src/main/services/dispatcher/dispatcher-copy.test.ts` fails on any string the app can show that names a coordinator or a second, hidden or background session.

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

## Agents' news in the chat (#3193)

What passes between the Dispatcher and an agent (progress, acknowledgements, an agent's questions to it) stays out of the chat. The agent's own chat keeps all of it. The chat shows only what is for the user:

- **A question or decision for the user** (`needs_user`) reaches the chat as a Clubhouse update, which the chat view doesn't show. The chat asks it in its own words, naming the agent, and that reply is the only time the user reads it. The user answers in the chat, which passes the answer on with `start_work`. Nothing tells them to reply to the agent.
- **A result they asked for** (`answer`) shows the same way while their request is open. Each request is answered once: by an answer, or by the Dispatcher's own reply that needs them, such as a question back. Before, a question back left the request open, and an agent's later progress, called an answer, showed in the chat.
- **Routine progress** waits for the next check-in.
- No turn follows to react to news: the chat is never told that the user already read something.
- News that names an agent Clubhouse can't find (a name two projects share, a typo) is still that agent's news, under the name given, and doesn't answer a request.
- News is remembered as shown when it is sent. If it never reaches the chat (a wake that asks first, a chat shutting down, a start that fails), that is undone: it can be sent again, and the request it answered opens again. A question for the user also goes out as a notification that opens the chat. A chat turn that fails after the message arrived isn't detected.

The rewrite step that put agents' news into their own voice under their own name (#3043) is gone; the `clubhouse.dispatcher.news.rewrite` attributes stay on the triage event, always `none`.

A separate thread per agent was considered instead. It would keep the clutter out of the main chat but leave the user two places to watch, put questions that need them out of sight, and need new UI on desktop and phone. The fix in place keeps one conversation.

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

Clears `memory/` (including upkeep's `memory/archive/`), an unsorted `notes/`, every `notes-archive*`, and news held for the next check-in, then makes a fresh index and rewrites its instructions. It never touches its agents, connections, links, permissions, Actions, Behavior, personality, usage history or its chat. Clear chat is the separate way to start the chat over.

## Files

All under the Clubhouse base folder (`~/.clubhouse`, or `.clubhouse-dev` in development) unless noted:

| File | Holds | Cleared by Forget everything |
|---|---|---|
| `dispatcher/memory/` | memory | yes |
| `dispatcher/notes-archive*/` | notes from before memory | yes |
| `dispatcher-news.json` | open requests, held news, recently shown | held news only |
| `dispatcher-agent-cards.json` | when each agent was asked for its card | no (a missing page asks again) |
| `dispatcher-usage.json` | 31 days of usage, conversations and background work | no |
| `dispatcher-upkeep.json` | when upkeep last ran | no |
| `dispatcher-settings.json` (app settings folder) | switch, Behavior, chosen models and what they replaced, personality, setup state | no |
