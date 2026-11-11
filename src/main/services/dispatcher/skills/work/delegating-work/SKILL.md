---
name: delegating-work
description: How to find who owns a piece of work, hand it to them and see it through. Use for every user request that needs something done, and whenever you give an agent a task.
---

# Delegating work

1. **Find the owner.**
   - Work in a project: read the cards in `list_agents` and your notes in `memory/agents/`. Among that project's agents, match "when to reach it" first, then "owns", then "what it's for". Prefer its orchestrator for work with several steps.
   - Setup on this computer that no project owns yet, such as cloning a repository: it's yours. See "Machine setup you do yourself" in your instructions.
   - Being free or recently active doesn't make an agent the owner. Never hand work to an agent whose project it isn't.
   - If nobody fits, tell the user with `tell_user` (`needs_user`) and offer to create or connect an agent. Don't guess. To create one you can reach, use `create_managed_agent` with `connectToDispatcher: true`. It asks first by default. Wait for approval and repeat the exact call, then check `connectedToDispatcher` and the receipt before waking it with its task. Without that option, the agent is asleep and unconnected, so the user must enable Connect to Dispatcher first. A retry in the same app session returns the created agent's receipt and never restores a user-removed connection. Existing agents and their switches stay under the user's control.
2. **Check before you promise.** Before you split the work or say it will happen, make sure each part has an owner or a tool. If a part has none, say so with `needs_user` first, before you start the rest.
3. **Check what you already know.** Read the topic page if the work has one. Don't ask an agent something its card or your memory answers.
4. **Send the task.** A running agent gets it through its `send_message`. A sleeping one gets it as the `message` of its `wake_agent`, in one call. Say:
   - what to do and why,
   - what done looks like,
   - what it depends on and what waits on it,
   - "Message me when it's done or if you're stuck."
   Give the goal and let the agent plan. Don't split its work into helper tasks for it.
5. **Work across projects in order.** For example, the SDK first, then the apps that use it. Start the first piece, and start the next when you hear it finished. Tell each agent what comes before and after it.
6. **Follow up without polling.** The agent's message wakes you. For an event, such as a push to main or an agent finishing a turn, `subscribe` with a note saying what to do next. Look with `get_status` or `read_output` only when the user asks or a check-in needs it.
7. **Write it down.** Start or update `memory/topics/<topic>.md` (`Status: unconfirmed` until the agent confirms the plan), add a timeline line, and point to the topic from `index.md` while it is going on.
8. **Report the outcome.** When the work is done, stuck, or needs a decision, call `tell_user` once with `answer` (or `needs_user` for a decision) and the hand-off's `request_id`. When an agent did the work, set `from` to it. When some steps are done and the rest failed, list the done ones in `done`, so a retry picks up from there. The user already knows it started, so don't report "I sent it". If you couldn't start it at all, such as an agent that refused or isn't connected, or no Clubhouse tool does it, say so right away, and how the user can allow it. Never work around it through the app's windows.
