# Actions

An action is a small workflow built into Clubhouse. When its trigger fires, it does one to three steps in order.

Actions run whenever Clubhouse is open, even with no window or project open. They run on this machine only.

## Triggers

- **On a schedule:** every day, weekdays, every week or every hour at a time you pick. **Custom (cron)** takes a five-part schedule line for anything else. The form shows the schedule in plain words and lists the next three runs. Schedules use your local time.
- **After something happens:** an agent wakes, goes to sleep, is created or deleted, finishes a turn, has a turn fail, goes idle for a while, waits on you, hits an error or compacts its context; one of its helpers finishes; a new commit, a branch switch, or a push, pull or fetch; Clubhouse starts; a project is added or removed. Pick one agent, or any agent in a project.
- **Once, at a time:** runs at that time and then deletes itself. If Clubhouse is closed then, it runs when Clubhouse next opens.

### Waiting first

**Clubhouse returns to use** fires once when you come back after at least 30 minutes away, or a threshold you set of at least 5 minutes. It combines app focus with screen lock, system sleep or OS input idle time. Switching windows alone does not count. Screen-lock and sleep signals work even if Clubhouse was frontmost. Relaunching the app does not count, and it does not replay returns from while the app was closed.

Presence tracking is local and runs only while an enabled action uses this event. It does not claim system-wide human presence. If OS idle time is unavailable, only lock and sleep can qualify an absence. Absence duration and timestamps are not included in agent messages or run history.

Lock and unlock are detected only on macOS and Windows; Linux relies on focus, suspend and resume, plus idle time where the system reports it.

An event trigger can wait, for example 30 minutes after an agent goes to sleep. When the wait ends, Clubhouse checks that what happened still holds. If the agent woke up in the meantime, the run is cancelled, and the wait starts again the next time it goes to sleep.

**Goes idle for** works the same way: the time counts from the end of the agent's last turn, a new turn resets it, and the action runs once per idle stretch.

### Event time filters

Every event trigger can optionally run only **After local time**, in HH:MM on this computer, and **Once per calendar day**. Events before the set time are ignored, not held until later. Delayed and queued runs check the current time and date again before starting. The filters also apply to Run now.

A started run uses the day, including failed runs and Run now. Skipped or cancelled runs that never started do not. The local date is saved independently of history and survives restart and edits.

Once per calendar day; moving the clock back doesn't give an extra run. This includes a repeated hour at the end of daylight saving time and moving back to an earlier date after a timezone change. A later local date is needed for another run. A spring-forward jump past the set time allows the next qualifying event, without replaying missed events.

### Missed times

If Clubhouse was closed or the machine was asleep at a schedule time, the action skips it by default. You can choose to run once when Clubhouse opens, or to run each missed time, up to 10.

## Steps

- **Wake an agent**, with an optional prompt. It resumes the agent's last session, the same as waking it by hand.
- **Message an agent.** If it's busy, the message waits for its next turn. If it's asleep, it's woken with the message.
- **Start a quick agent** in a project folder or in another agent's worktree. It shows in the sidebar named after the action. Agent steps run with Full access and without a window, even if the project starts quick agents in a terminal, so a scheduled run never stops to ask. An agent can have actions that start quick agents only if it runs with Full access itself and is allowed to start helpers. The Dispatcher's actions can't start them.
- **Put an agent to sleep.** A chat agent in the middle of a turn gets up to 10 minutes to finish first.
- **Notify me.** A Clubhouse notification, following Settings > Notifications & alerts.

Steps stop at the first one that couldn't run.

## When an action can't run

You get a notice only when an action couldn't do its job: an agent couldn't wake or start, a provider isn't installed, a target is gone, or the action is no longer allowed to do a step. The reason shows on the action's row and card. There are no retries; the next run happens as usual.

If an agent an action uses is deleted, the action turns off and says why.

## Who made it

You, the Dispatcher and agents can all make actions. An action's usage counts toward whoever made it. Agents manage their own actions through Clubhouse, and a helper's actions are deleted with the helper.

An agent's action can do only what the agent itself may. Its steps and what it watches follow the agent's Clubhouse permissions, so turning a permission off reaches its actions too. A permission set to Ask first counts as no, because nobody is there to ask when an action runs.

### Being told when something happens

An agent can ask to be told when something happens, for example "tell me when main is pushed". That becomes an action the agent owns, with one step that messages it, and shows in the list as "Tell" followed by the agent's name. The message says what happened. The Dispatcher keeps track of your agents the same way. You can turn these off or delete them like any other action.

## Limits

Schedule and event actions can have an optional **Ends at** time and **Maximum runs**. Every started run counts, including scheduled runs, events, missed-time catch-up, Run now and failures. Runs skipped because another run is still going or the hourly limit was reached do not count.

The lifetime count survives restarts, sleep and edits, independently of the shorter history. The card shows the remaining runs and end time. At either limit the action turns off and says why, keeping its history. No new run starts at or after the end time, including delayed or queued runs and missed-time catch-up after restart. A run already in progress finishes normally.

One-time actions do not have these limits. Over MCP, create_action and update_action accept endsAt (epoch milliseconds or a date and time) and maxRuns (a positive whole number). list_actions returns them with runsUsed. Pass null to remove a limit.

An action set off by another action carries that chain along. A chain stops after three actions, an action can't set itself off, and one action runs at most 60 times an hour.

## History

Each action keeps its last 10 runs from the past 72 hours: when it ran, what set it off, how it went, and links to the agents it woke or started. Open an action from **Settings > Actions** to see them. **Run now** runs an action straight away for testing.

Every agent also has an **Actions** card in **Details**. It groups actions made by that agent, actions that act on it and actions its events set off, using the same list as the agent's Actions settings page. Open a row to see its history, run it now, turn it on or off, edit it or delete it without leaving the agent. These are your controls; the action keeps its original owner and permissions. The Dispatcher's card keeps the actions it made.

A message accepted into an agent's queue records "Queued for" followed by the agent's name and "next turn" instead of "Sent". The action fired, but this is not confirmed delivery. The run stays Done and does not track later queue delivery, removal or failure.
