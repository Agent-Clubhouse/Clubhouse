---
name: delegating-work
description: How to hand a piece of work to the right agent and see it through. Use for a user request that needs work done in a project, and whenever you give an agent a task.
---

# Delegating work

1. **Find the owner.** Read the cards in `list_agents` and your notes in `memory/agents/`. Match the request to "when to reach it" first, then "owns", then "what it's for". Prefer an orchestrator for work with several steps. If nobody fits, tell the user with `tell_user` (`needs_user`) and offer to create or connect an agent. Don't guess.
2. **Check what you already know.** Read the topic page if the work has one. Don't ask an agent something its card or your memory answers.
3. **Send the task.** A running agent gets it through its `send_message`. A sleeping one gets it as the `message` of its `wake_agent`, in one call. Say:
   - what to do and why,
   - what done looks like,
   - what it depends on and what waits on it,
   - "Message me when it's done or if you're stuck."
   Give the goal and let the agent plan. Don't split its work into helper tasks for it.
4. **Work across projects in order.** For example, the SDK first, then the apps that use it. Start the first piece, and start the next when you hear it finished. Tell each agent what comes before and after it.
5. **Follow up without polling.** The agent's message wakes you. For an event, such as a push to main or an agent finishing a turn, `subscribe` with a note saying what to do next. Look with `get_status` or `read_output` only when the user asks or a check-in needs it.
6. **Write it down.** Start or update `memory/topics/<topic>.md` (`Status: unconfirmed` until the agent confirms the plan), add a timeline line, and point to the topic from `index.md` while it is going on.
7. **Report the outcome.** When the work is done, stuck, or needs a decision, call `tell_user` once with `answer` (or `needs_user` for a decision). The user already knows it started, so don't report "I sent it". If you couldn't start it at all, such as an agent that refused or isn't connected, or no Clubhouse tool does it, say so right away, and how the user can allow it. Never work around it through the app's windows.
