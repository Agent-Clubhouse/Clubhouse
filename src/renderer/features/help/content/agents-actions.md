# Actions

An action is a small workflow built into Clubhouse. When its trigger fires, it does one to three steps in order.

Actions run whenever Clubhouse is open, even with no window or project open. They run on this machine only.

## Triggers

- **On a schedule:** every day, weekdays, every week or every hour at a time you pick. **Custom (cron)** takes a five-part schedule line for anything else. The form shows the schedule in plain words and lists the next three runs. Schedules use your local time.
- **After something happens:** an agent wakes, goes to sleep, is created or deleted, finishes a turn, has a turn fail, goes idle for a while, waits on you, hits an error or compacts its context; one of its helpers finishes; a new commit, a branch switch, or a push, pull or fetch; Clubhouse starts; a project is added or removed. Pick one agent, or any agent in a project.
- **Once, at a time:** runs at that time and then deletes itself. If Clubhouse is closed then, it runs when Clubhouse next opens.

### Waiting first

An event trigger can wait, for example 30 minutes after an agent goes to sleep. When the wait ends, Clubhouse checks that what happened still holds. If the agent woke up in the meantime, the run is cancelled, and the wait starts again the next time it goes to sleep.

**Goes idle for** works the same way: the time counts from the end of the agent's last turn, a new turn resets it, and the action runs once per idle stretch.

### Missed times

If Clubhouse was closed or the machine was asleep at a schedule time, the action skips it by default. You can choose to run once when Clubhouse opens, or to run each missed time, up to 10.

## Steps

- **Wake an agent**, with an optional prompt. It resumes the agent's last session, the same as waking it by hand.
- **Message an agent.** If it's busy, the message waits for its next turn. If it's asleep, it's woken with the message.
- **Start a quick agent** in a project folder or in another agent's worktree. It shows in the sidebar named after the action. It starts at the Access level you pick, or your Default access. An action an agent made never starts one above that agent's own access, and only an agent allowed to start helpers can have its actions start quick agents.
- **Put an agent to sleep.** A chat agent in the middle of a turn gets up to 10 minutes to finish first.
- **Notify me.** A Clubhouse notification, following Settings > Notifications & alerts.

Steps stop at the first one that couldn't run.

## When an action can't run

You get a notice only when an action couldn't do its job: an agent couldn't wake or start, a provider isn't installed, a target is gone, or the action is no longer allowed to do a step. The reason shows on the action's row and card. There are no retries; the next run happens as usual.

If an agent an action uses is deleted, the action turns off and says why.

## Who made it

You, the Dispatcher and agents can all make actions. An action's usage counts toward whoever made it. Agents manage their own actions through Clubhouse, and a helper's actions are deleted with the helper.

## Limits

An action set off by another action carries that chain along. A chain stops after three actions, an action can't set itself off, and one action runs at most 60 times an hour.

## History

Each action keeps its last 10 runs from the past 72 hours: when it ran, what set it off, how it went, and links to the agents it woke or started. Open an action from **Settings > Actions** to see them. **Run now** runs an action straight away for testing.
