# Cookbook: UI Work

## When to use
Tasks involving visual/interaction design alongside implementation — new UI features, design system changes, component overhauls. Adds a design review gate to the basic job pattern.

## Team
- **1 Executor** — implements the UI code, opens PRs (executor-merge persona)
- **1 QA** — reviews code quality, test coverage, spec compliance (qa persona)
- **1 UI Lead** — owns visual design, reviews UI changes for consistency (ui-lead persona)

QA and UI Lead operate independently — they don't review each other's work.

## Canvas Layout

Cards:
- 1 zone card: "UI Work" (contains all agents)
- 1 agent card: Executor
- 1 agent card: QA reviewer
- 1 agent card: UI Lead

Wires:
- Executor -> QA (code review)
- Executor -> UI Lead (design review)
- QA and UI Lead are NOT wired to each other

Layout: `hub_spoke` — executor at center, reviewers around it.

## MCP Tool Sequence

```
1. create_canvas({ name: "<feature-name> UI" })
2. add_card({ canvas_id, type: "zone", display_name: "UI Work" })
3. create_agent({ project_path, name: "Executor", persona: "executor-merge" })
4. add_card({ canvas_id, type: "agent", agent_id: executor_id, project_id, zone_id })
5. create_agent({ project_path, name: "QA", persona: "qa" })
6. add_card({ canvas_id, type: "agent", agent_id: qa_id, project_id, zone_id })
7. create_agent({ project_path, name: "UI Lead", persona: "ui-lead" })
8. add_card({ canvas_id, type: "agent", agent_id: ui_lead_id, project_id, zone_id })
9. connect_cards({ source_view_id: executor_card_id, target_view_id: qa_card_id })
10. connect_cards({ source_view_id: executor_card_id, target_view_id: ui_lead_card_id })
11. layout_canvas({ canvas_id, pattern: "hub_spoke" })
```

## Coordination
PRs require approval from both QA (code quality) and UI Lead (design consistency) before merge. UI Lead delivers design specs as markdown docs, not code.
