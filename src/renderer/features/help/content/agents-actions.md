# Actions

An action is a small workflow built into Clubhouse. When its trigger fires, it does one to three steps in order.

Actions run whenever Clubhouse is open, even with no window or project open. They run on this machine only.

## Triggers

- **On a schedule:** every day, weekdays, every week or every hour at a time you pick. **Custom (cron)** takes a five-part schedule line for anything else. The form shows the schedule in plain words and lists the next three runs. Schedules use your local time.
- **After something happens:** an agent wakes, goes to sleep, is created or deleted, finishes a turn, has a turn fail, goes idle for a while, waits on you, hits an error or compacts its context; a quick agent finishes; one of its helpers finishes; a new commit, a branch switch, or a push, pull or fetch; Clubhouse starts; a project is added or removed. Pick one agent, or any agent in a project.
- **Once, at a time:** runs at that time and then deletes itself. If Clubhouse is closed then, it runs when Clubhouse next opens.

### Waiting first

**Clubhouse returns to use** fires once when you come back after at least 30 minutes away, or a threshold you set of at least 5 minutes. It combines app focus with screen lock, system sleep or OS input idle time. Switching windows alone does not count. Screen-lock and sleep signals work even if Clubhouse was frontmost. Relaunching the app does not count, and it does not replay returns from while the app was closed.

Presence tracking is local and runs only while an enabled action uses this event. It does not claim system-wide human presence. If OS idle time is unavailable, only lock and sleep can qualify an absence. Absence duration and timestamps are not included in agent messages or run history.

Lock and unlock are detected only on macOS and Windows; Linux relies on focus, suspend and resume, plus idle time where the system reports it.

An event trigger has one **Timing** mode: run without waiting, wait after the latest event, or group events from the first event. A delay and a grouping window cannot be combined. Any readable agent always uses grouping; idle triggers always use a delay.

A delay is a trailing debounce in whole **seconds or minutes**, up to one week. For example, wait 30 seconds after the last event or 30 minutes after an agent goes to sleep. Each matching event restarts the wait. Agent sources have an independent wait for each agent. When the wait ends, Clubhouse checks that what happened still holds. If the agent woke up in the meantime, the run is cancelled. Pending waits survive relaunch and are rechecked then. Older actions saved with `delayMinutes` keep the same behavior; `delaySeconds` is an alternative, not an additional wait.

**Goes idle for** works the same way: the time counts from the end of the agent's last turn, a new turn resets it, and the action runs once per idle stretch.

Terminal turn events depend on the CLI's hooks. Claude reports prompt starts, completed and failed turns, and compaction. Codex reports prompt starts, completed and interrupted turns, and compaction. Claude interruptions have no hook, and Copilot has no per-turn completion hook. Tool errors and session exits are not turn failures or turn completions.

A turn reports one ending, the first the provider sends; a failure reported after a completed ending isn't shown.

Claude failure events include only a recognized error category, not free-form provider details that could contain conversation content or credentials.

Clubhouse preserves existing hook settings. Invalid or commented JSON and customized Clubhouse callback groups require manual review before the agent can start; they are not overwritten.
Headless quick agents report one turn end per run, including empty output, process failures, stops and replacements. A provider failure is a failed turn even if the process exits successfully. Error events contain only a category, not prompts, output or error content.

**A quick agent finishes** (`agent.quick_finished`) fires once when its run ends, with a completed, failed or cancelled outcome. The app event includes its name, starter (you, an agent or an Action), parent when present, project and duration. It does not include prompts or output. Watching a quick agent uses `agent.read` on that quick agent, including for project sources. Its parent counts as the `my_helper` relation, as with durable helpers. Actions you create use your own access. Minimal quick-run identity and permission scope stay available locally for up to one week so delayed delivery can recheck access, and are not saved in actions.json. Delayed waits keep the source agent's id so the read check still applies after relaunch.

Quick-source names in messages and missions are marked as untrusted event data, including when a wake step has no prompt. Names and event summaries lose control characters and line breaks before delivery.

### Grouping events and throttling

Every event source can use a fixed grouping window of 10 to 600 seconds. The first matching event starts the window. Later events join without extending it. Agent, git and app sources all use the same grouping mechanism. The run context lists every readable event; the text summary shows up to 20 entries, with length-limited text and a count of the rest. The owner's permissions are checked for each member when collected, before the run starts, and between steps. Revoked members are removed from the summary and context. Grouped messages and quick-agent prompts quote the summary as untrusted data.

Grouping buffers are live only. Turning off, editing or deleting the action discards its pending group. Relaunch does not replay events.

An optional **Throttle maximum runs** and **Throttle window (minutes)** limit started runs in a sliding window, including Run now and failures. For example, 2 runs per 5 minutes allows another run exactly 5 minutes after the oldest started run. It is not a fixed calendar interval. The window survives restart independently of trimmed history.

The order is the timing mode, then throttle at actual run start, then the daily and lifetime limits and overlap rule. A run waiting behind another run rechecks throttle before starting. Throttle can be used with any timing mode, including any-agent grouping. A throttled attempt is recorded as **Throttled** and consumes neither Maximum runs nor Once per calendar day. The existing hourly safety cap and chain guards are unchanged.

### Event time filters

Every event trigger can optionally run only **After local time**, in HH:MM on this computer, and **Once per calendar day**. Events before the set time are ignored, not held until later. Delayed and queued runs check the current time and date again before starting. The filters also apply to Run now.

A started run uses the day, including failed runs and Run now. Skipped or cancelled runs that never started do not. The local date is saved independently of history and survives restart and edits.

Once per calendar day; moving the clock back doesn't give an extra run. This includes a repeated hour at the end of daylight saving time and moving back to an earlier date after a timezone change. A later local date is needed for another run. A spring-forward jump past the set time allows the next qualifying event, without replaying missed events.

### Any readable agent

For **Finishes a turn**, **Has a turn fail** and **A quick agent finishes**, you can watch **Any readable agent** across projects. This includes durable agents, their durable helpers and quick agents. It excludes the subscriber, both Dispatcher identities and Dispatcher-owned helpers. Each agent must be readable by the action's owner, using its existing `agent.read` permission.

An agent also needs `agent.watch` on the app to watch activity across agents. It is allowed by default for the Dispatcher and can be turned off on its Clubhouse permissions page. Other agents have no default grant. Set it to Allow on the owner's Clubhouse permissions page, or ask for that permission first. Ask first and Off do not allow unattended activity watching. Both this grant and each agent's read access are checked again before delivery, including queued runs. Membership is dynamic: agents that become readable later join without editing the action.

Actions created by you in Settings use your access, not an agent's grants. They watch all eligible agents, with the same exclusions. Agents without an Allow grant for activity watching cannot see any-agent actions over MCP. Agents with that grant can see action status and remaining runs. Their last-run details and history use their current read permissions, even for actions you created and retained history from edited or deleted actions. Partially redacted runs omit merged causes and unreadable step-target results and reasons, and use the run's start time rather than the first member's turn time.

Turns or quick finishes are grouped for 60 seconds by default, configurable from 10 seconds to 10 minutes. The first qualifying event starts a fixed window. Later events join it without extending the end time, and each involved agent appears once. The message names up to 20 agents and says how many more there are; the step context includes every involved readable agent. Agent names are length-limited and stripped of line breaks and control characters. Delivered messages and quick-agent prompts quote the summary as untrusted event data, separate from the action's instructions. This source uses its grouping window instead of Wait first, and cannot combine with `delayMinutes` or `delaySeconds`.

Buffers are kept only while Clubhouse is running. Turning off, editing or deleting the action discards its pending group. Relaunching does not replay turns. The usual overlap, hourly, chain, time and daily limits still apply to the grouped run.

### Missed times

If Clubhouse was closed or the machine was asleep at a schedule time, the action skips it by default. You can choose to run once when Clubhouse opens, or to run each missed time, up to 10.

### Annex devices

**A device comes online** and **A device goes offline** watch computers and phones in this computer's Annex Network. You can pick a specific device, a device kind, or both. Each computer reports only what it sees directly. Events are not synchronized or deduplicated across your computers, so the same device can fire an action on several computers.

At launch, each device already connected fires one online event after a short settling window. Local screen lock, sleep, loss of this computer's network and quitting do not turn other devices into offline events. After unlock, wake or reconnect, Clubhouse lets Annex recover and reports only real differences from its last trustworthy view. Detection follows Annex reconnect and heartbeat timing, not a separate probe.

The form starts device events with **Timing** set to **Wait after the latest event** and **Wait first** set to 120 seconds. When the wait ends it checks the device's current state again. Each device has its own wait, and another matching transition restarts that device's wait, so brief Wi-Fi flapping does not deliver repeated messages.

You can instead choose no wait or a fixed grouping window. Device grouping windows are independent too: each device starts its own window, and later events for that device join without extending it. Grouping records what happened, rather than re-checking the current state. Throttle remains a limit on the whole action's started runs across all devices, including Run now, and composes with any timing mode. Daily, lifetime and overlap limits also remain per action.

Agent-owned device actions require `device.read` set to Allow when admitted and when they run. The Dispatcher already has this permission by default. Ask first is not enough for unattended actions. Readers without it cannot see device actions or their device-related history over MCP, including history retained after an edit or deletion. Events contain only the device's id, name and kind (computer or phone), never addresses, ports or certificates.

## Steps

- **Wake an agent**, with an optional prompt. It resumes the agent's last session, the same as waking it by hand.
- **Message an agent.** If it is busy, **Queue for the next turn** is the default. **Steer the current turn** uses the same mid-turn delivery path as your own messages. When the provider cannot steer, it falls back to queue. A sleeping agent is woken with the message.
- **Start a quick agent** in a project folder or in another agent's worktree. It shows in the sidebar named after the action. Agent steps run with Full access and without a window, even if the project starts quick agents in a terminal, so a scheduled run never stops to ask. An agent can have actions that start quick agents only if it runs with Full access itself and is allowed to start helpers. The Dispatcher's actions can't start them.
- **Put an agent to sleep.** A chat agent in the middle of a turn gets up to 10 minutes to finish first.
- **Notify me.** A Clubhouse notification, following Settings > Notifications & alerts.

Steps stop at the first one that couldn't run.

A quick-agent step can use **Auto** with easy, medium or hard difficulty (medium by default). It uses the same provider selection, quota checks and model mappings as helpers in **Settings > Smart selection**. Its routing receipt appears in recent runs. If Auto is off or no provider can run it, the step says why and does not start. An explicit provider stays explicit. Steps saved without a provider still use the project's provider.

An agent-owned action also follows its owner's Auto setting, checked again before the provider is chosen. Your actions follow the app and project settings.

Message steps can enable **Keep only the latest queued message**. A newer queued message from the same action replaces its older undelivered messages. Messages from other actions and your own messages are not replaced. This is off by default.

**Maximum queue wait (minutes, optional)** removes a message that is still undelivered when the time passes. It is logged and recorded as **Expired** in run history. This also applies if steering falls back to queue. There is no maximum wait by default. These settings are per message step, including steps targeting the Dispatcher. Over MCP, use `delivery: "queue" | "steer"`, `latestOnly` and `maxWaitMinutes` on the step.

## When an action can't run

You get a notice only when an action couldn't do its job: an agent couldn't wake or start, a provider isn't installed, a target is gone, or the action is no longer allowed to do a step. The reason shows on the action's row and card. There are no retries; the next run happens as usual.

If an agent an action uses is deleted, the action turns off and says why.

## Who made it

You, the Dispatcher and agents can all make actions. An action's usage counts toward whoever made it. Agents manage their own actions through Clubhouse, and a helper's actions are deleted with the helper.

When the Dispatcher creates or changes an action through Clubhouse, its chat shows the name, trigger, steps and on or off state. **Open** opens it in Settings. **Turn off** is your control, using the same path as the switch in Settings.

An agent's action can do only what the agent itself may. Its steps and what it watches follow the agent's Clubhouse permissions, so turning a permission off reaches its actions too. A permission set to Ask first counts as no, because nobody is there to ask when an action runs.

### Being told when something happens

An agent can ask to be told when something happens, for example "tell me when main is pushed". That becomes an action the agent owns, with one step that messages it, and shows in the list as "Tell" followed by the agent's name. The message says what happened. The Dispatcher keeps track of your agents the same way. You can turn these off or delete them like any other action.

## Limits

Schedule and event actions can have an optional **Ends at** time and **Maximum runs**. Every started run counts, including scheduled runs, events, missed-time catch-up, Run now and failures. Runs skipped because another run is still going, throttle refused the start, or the hourly limit was reached do not count. A queued message that expires later still belongs to a run that started, so that run remains counted.

The lifetime count survives restarts, sleep and edits, independently of the shorter history. The card shows the remaining runs and end time. At either limit the action turns off and says why, keeping its history. No new run starts at or after the end time, including delayed or queued runs and missed-time catch-up after restart. A run already in progress finishes normally.

One-time actions do not have these limits. Over MCP, create_action and update_action accept endsAt (epoch milliseconds or a date and time) and maxRuns (a positive whole number). list_actions returns them with runsUsed. Pass null to remove a limit.

An action set off by another action carries that chain along. A chain stops after three actions, an action can't set itself off, and one action runs at most 60 times an hour.

A quick agent started by an Action carries that Action's chain for its entire run, including completion and startup failure. Its finish cannot trigger the same Action again, even if the run lasts longer than 30 minutes.

## History

Each action keeps its last 10 runs from the past 72 hours: when it ran, what set it off, how it went, and links to the agents it woke or started. A later queue receipt refreshes that retention time so an expiry is visible even after a long wait. Open an action from **Settings > Actions** to see them. **Run now** runs an action straight away for testing.

**By owner** in Settings > Actions groups your actions, each agent's actions and the Dispatcher's actions. It lists recent runs and failures in the last 24 hours and 7 days, including retained runs of deleted and one-time actions. These counts include skipped and cancelled runs. History is trimmed to 10 runs per action within 72 hours, so they are not complete usage totals for either period. Older history without an owner uses the saved action's owner when available; otherwise it appears under **Unknown owner**.

Every agent also has an **Actions** card in **Details**. It groups actions made by that agent, actions that act on it and actions its events set off, using the same list as the agent's Actions settings page. Open a row to see its history, run it now, turn it on or off, edit it or delete it without leaving the agent. These are your controls; the action keeps its original owner and permissions. The Dispatcher's card keeps the actions it made.

A message accepted into an agent's queue records "Queued for" followed by the agent's name and "next turn" instead of "Sent". This is an acceptance receipt, not confirmed delivery. Client queue receipts update the step when it is delivered, replaced or dropped. An expired message marks the run Expired; replacement or removal marks an otherwise successful run Cancelled. History says why. A run that already failed keeps its failure and also shows the message's delivery outcome.

The client message queue does not survive relaunch. On shutdown its held messages are recorded as dropped. After an interrupted shutdown, any retained unconfirmed queue receipts are marked dropped on next launch, cancelling otherwise successful runs instead of leaving them marked Done.
