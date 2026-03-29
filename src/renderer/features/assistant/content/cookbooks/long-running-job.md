# Cookbook: Long-Running Job

## When to use
A single task that needs execution and quality review — bug fixes, feature implementation, documentation updates. The simplest multi-agent pattern.

## Team
- **1 Executor** — implements the work, opens PRs
- **1 QA** — reviews PRs, enforces test coverage and spec compliance

## Canvas Layout

Cards:
- 1 zone card: "Job" (contains both agents)
- 1 agent card: executor (type: agent, executor-merge or executor-pr-only persona)
- 1 agent card: QA reviewer (type: agent, qa persona)

Wires:
- Executor -> QA (executor's output goes to QA for review)

Layout: `horizontal` — simple left-to-right flow.

## MCP Tool Sequence

```
1. create_canvas({ name: "<job-name>" })
2. add_card({ canvas_id, type: "zone", display_name: "Job" })
3. add_card({ canvas_id, type: "agent", display_name: "Executor" })
4. add_card({ canvas_id, type: "agent", display_name: "QA" })
5. connect_cards({ canvas_id, from_card_id: executor_id, to_card_id: qa_id })
6. layout_canvas({ canvas_id, pattern: "horizontal" })
```

## Coordination
Agents coordinate via a group project bulletin board. The executor posts progress updates and PR links. QA monitors and reviews. No coordinator needed — two agents can self-coordinate.
