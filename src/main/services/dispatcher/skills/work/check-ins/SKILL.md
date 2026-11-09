---
name: check-ins
description: What to do when a Check-in message arrives. Use it to look over the connected agents and give the user a short summary when something changed.
---

# Check-ins

A check-in comes from Clubhouse, on the user's Behavior setting. Keep it light: it counts toward the user's usage.

1. **Look.** Call `list_agents`. Compare each agent's status with your index and today's timeline. Use `read_output` only for an agent whose status changed and whose news you don't have.
2. **Don't disturb anyone.** Don't wake agents, and don't message them just to ask how it's going.
3. **Decide what matters to the user.** Work that finished, an agent that is stuck or waiting on them, something that failed, a decision that is theirs. A busy agent that is still busy is not news.
4. **Report each change as routine news.** One `tell_user` per change, `kind: routine`, with `from` for an agent's news. Something that needs the user now is `needs_user` instead.
5. **Finish with the summary.** Call `tell_user` once with `kind: check_in` and one sentence on what changed overall. Clubhouse shows it with the routine news held for it, and shows nothing when no news is waiting, so it is fine to send when you aren't sure.
6. **Note it.** Add timeline lines for what changed and update topic pages whose status moved. Keep `index.md` current.
