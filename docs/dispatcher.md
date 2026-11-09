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
| Chat with zero tool noise, agents' news rewritten into short interjections, triage (now, next check-in, never), check-ins only when something changed, Clear chat | #3043 | `dispatcher-news.ts`, `dispatcher-triage.ts`, `dispatcher-rewrite.ts`, `dispatcher-clear-chat.ts`, `features/dispatcher/group-chat.ts` |
| Wake on message | #3037 | `clubhouse-mcp/tools/dispatcher-delivery.ts` |
| Memory: plain markdown index, agent pages, timeline, topics; old `notes/` sorted in once | #3038 | `dispatcher-memory*.ts` |
| Search over memory and transcripts | #3039 | `dispatcher-search.ts` |
| Hidden upkeep and check-in Actions tied to Behavior; usage split into conversations and background work | #3040 | `dispatcher-background*.ts`, `dispatcher-upkeep.ts`, `dispatcher-usage.ts` |
| Agent cards (`update_my_card`), asked on connect and setup change | #3041 | `dispatcher-agent-cards*.ts` |
| Subscriptions: agent-owned Actions that message the agent | #3042 | `shared/actions/subscription.ts`, `actions/engine.ts` |
| Auto minimum and maximum levels | #3044 | Auto mapping |
| Behavior: Light, Standard, Thorough; composer chip | #3045 | `shared/dispatcher-behavior.ts`, `features/dispatcher/BehaviorChip.tsx` |
| Settings page with Connected agents and Forget everything | #3046 | `features/settings/DispatcherSettingsView.tsx`, `dispatcher-forget.ts`, `dispatcher-connected-agents.ts` |
| First-run setup, personality and presets, Try it out | #3047 | `dispatcher-setup.ts`, `shared/dispatcher-personality.ts`, `features/dispatcher/DispatcherSetup.tsx` |
| Teaching: intro, suggestions, "What else can you do?" from real grants | #3048 | `shared/dispatcher-teaching.ts` |
| An agent's Dispatcher card in Details | #3049 | `features/agents/details/DispatcherCard.tsx` |
| `project.add` (ask first) and the Dispatcher's default grants | #3050 | `shared/agent-grants.ts`, `shared/default-grants.ts` |
| Telemetry: usage split, memory health, triage outcomes | #3052 | `src/main/telemetry/dispatcher-telemetry.ts` |
| Phone: the same group chat | #3043 | `mobile-dispatcher.ts` |

## Its name

The saved name, cleaned, or `DEFAULT_DISPATCHER_NAME` when it's blank, comes from `dispatcherDisplayName()` in `dispatcher-service.ts`. Its wires to connected agents carry it (`dispatcher-wire-source.ts`), so agents see the name the user chose, and so do hand-offs and the agent-card requests. A rename changes the wires' signature; the state broadcast makes the wire watcher rebuild, and the bindings are relabelled in place, so no wire drops. Its agent is still created under the working name until setup or Settings renames it.

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
| `dispatcher-settings.json` (app settings folder) | switch, Behavior, personality, setup state | no |
