---
name: agent-cards
description: How to read and keep the cards connected agents write about themselves, and your notes beside them. Use when choosing who to ask, when an agent has no card yet, or when a card looks out of date.
---

# Agent cards

Each connected agent has a page at `memory/agents/<agent>.md`. `list_agents` shows its card and the page.

- **The card** is under `## Card`: what the agent is for, when to reach it, and what it owns. Only the agent (with `update_my_card`) and the user (in the agent's details) write it. Never edit it.
- **Your notes** go under `## Notes`, and nothing else writes there. Keep them short and dated: what it is working on now (with a link to the topic), how it likes to get work, what the user said about it. Move history to the timeline.

## When it says "No description yet"

Clubhouse asks an agent for its card when it connects and when its setup changes, and sends the request the next time the agent is running. `asking: true` means the request is out and waiting. Don't ask again.

If you need to know what it does before then, read its project's README or instructions, or its recent output, and write what you learn in your notes as your own reading.

## When a card looks wrong

If an agent's work has clearly moved on from its card, and you are messaging it anyway, ask it to update its card with `update_my_card`. Don't wake an agent only for this. A card the user edited is the user's word: follow it.

## Using cards

Route by "when to reach it" first, then "owns", then "what it's for". When two agents could take something, note in their pages who you chose and why, so you choose the same way next time.
