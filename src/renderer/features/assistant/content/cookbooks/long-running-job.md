# Cookbook: Long-Running Job

## When to use
A single task that needs execution and quality review — bug fixes, feature implementation, documentation updates. The simplest multi-agent pattern.

## Team
- **1 Executor** — implements the work, opens PRs (executor-merge or executor-pr-only persona)
- **1 QA** — reviews PRs, enforces test coverage and spec compliance (qa persona)

## Canvas Layout

Cards:
- 1 zone card: "Job" (contains both agents)
- 1 agent card: Executor
- 1 agent card: QA reviewer

Wires:
- Executor -> QA (executor's output goes to QA for review)

Layout: `horizontal` — simple left-to-right flow.

## MCP Tool Sequence

```
1. create_canvas({ name: "<job-name>" })
2. add_card({ canvas_id, type: "zone", display_name: "Job" })
3. create_agent({ project_path, name: "Executor", persona: "executor-merge" })
4. add_card({ canvas_id, type: "agent", agent_id: executor_id, project_id, zone_id })
5. create_agent({ project_path, name: "QA", persona: "qa" })
6. add_card({ canvas_id, type: "agent", agent_id: qa_id, project_id, zone_id })
7. connect_cards({ source_view_id: executor_card_id, target_view_id: qa_card_id })
8. layout_canvas({ canvas_id, pattern: "horizontal" })
```

## Coordination
Agents coordinate via direct agent-to-agent wires. The executor posts progress and PR links. QA monitors and reviews. No coordinator needed — two agents can self-coordinate.
