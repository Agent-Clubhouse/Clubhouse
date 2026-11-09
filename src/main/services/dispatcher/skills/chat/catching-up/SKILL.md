---
name: catching-up
description: How to answer "What's everyone working on?" and other status questions about the user's agents. Use when the user asks what is going on, what changed, or how a piece of work is doing.
---

# Catching up

1. Call `list_agents` for each agent's status, branch and card.
2. Call `read_memory` for the index, then read today's timeline and the topic pages for work that is going on.
3. Answer with the most important thing first: anything that needs the user. Then one short line per busy agent: who, what it's on, and where it stands (working, waiting on you, done). Put asleep or quiet agents together in one line.
4. Say what you don't know. If memory doesn't say what an agent is doing, say so and offer to find out, which goes through `start_work`.
5. Offer an obvious next step when there is one, such as waking an agent that a finished piece of work unblocks.
