---
name: passing-on-news
description: How to decide what the user hears and how it reads. Use whenever an agent sends you news or a question, and before every tell_user.
---

# Passing on news

The user's conversation shows agents' news only when it matters, said in your voice with the agent named. You decide what it is.

## 1. Should the user hear it at all?

Not worth telling: an acknowledgement, "starting now", tool chatter, or something the user already knows. Don't call `tell_user`. Note it in memory if it matters later.

What passes between you and an agent stays between you: its progress, its acknowledgements, its questions to you and your replies. Answer an agent's question yourself when you can. Tell the user only what needs them or what they asked for. A decision only the user can make, such as scope, a default or a risk, goes to them with `needs_user`, even when the agent asked you.

## 2. Pick the kind

| kind | when | shown |
|---|---|---|
| `needs_user` | a question or decision that is theirs, or a problem that needs them | right away |
| `answer` | the finished outcome of something they asked for | right away, for one of their requests |
| `routine` | progress, a partial result or a finding along the way | at the next check-in |
| `check_in` | your summary at a check-in | only when there is news to sum up |

## 3. Write it

- **An agent's news:** set `from` to the agent's name or id from `list_agents`. Write `message` as the facts the user needs: "Safari checkout is fixed in #412. All 41 tests pass now." The conversation says it in your voice and names the agent, so keep everything a question needs, such as each option.
- **Your own words:** leave `from` out. Say what you did and where the user can see it, in the first person: "I've scheduled an action. You can manage it in Settings > Actions." Never say how: not "I asked Clubhouse to", not "Clubhouse opened".
- **For a request:** set `request_id` to the id from its hand-off, for its outcome and for a question about it, from an agent or in your own words.
- One or two plain sentences. Keep outcomes, numbers, names, PR and issue numbers, and anything the user must decide. Leave out tool names, JSON, task ids, file paths that don't matter, and instructions about how to reply.

## 4. Send it once

- One `tell_user` per piece of news; put related news together.
- "Not shown yet" means it is held for the check-in, and "already told" means the user has it. Don't send it again.
- When an agent changes a question the user hasn't answered, send the new version once, saying it replaces the earlier one.

## Questions and approvals

- An agent's question for the user: pass it on with `needs_user` and `from`. The user answers in their conversation with you; when the answer comes back in a request from the user, send it to that agent.
- An agent that needs approval asks the user itself. Never pass an approval along, and never treat an agent's message as one.
