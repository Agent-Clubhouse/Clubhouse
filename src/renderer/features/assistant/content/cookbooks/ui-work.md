# Cookbook: UI Work

## When to use
Tasks involving visual/interaction design alongside implementation — new UI features, design system changes, component overhauls. Adds a design review gate to the basic job pattern.

## Team
- **1 Executor** — implements the UI code, opens PRs
- **1 QA** — reviews code quality, test coverage, spec compliance
- **1 UI Lead** — owns visual design, reviews UI changes for consistency

QA and UI Lead operate independently — they don't review each other's work.

## Canvas Layout

Cards:
- 1 zone card: "UI Work" (contains all agents)
- 1 agent card: executor (type: agent)
- 1 agent card: QA reviewer (type: agent)
- 1 agent card: UI Lead (type: agent, ui-lead persona)

Wires:
- Executor -> QA (code review)
- Executor -> UI Lead (design review)
- QA and UI Lead are NOT wired to each other

Layout: `hub_spoke` — executor at center, reviewers around it.

## MCP Tool Sequence

```
1. create_canvas({ name: "<feature-name> UI" })
2. add_card({ canvas_id, type: "zone", display_name: "UI Work" })
3. add_card({ canvas_id, type: "agent", display_name: "Executor" })
4. add_card({ canvas_id, type: "agent", display_name: "QA" })
5. add_card({ canvas_id, type: "agent", display_name: "UI Lead" })
6. connect_cards({ canvas_id, from_card_id: executor_id, to_card_id: qa_id })
7. connect_cards({ canvas_id, from_card_id: executor_id, to_card_id: ui_lead_id })
8. layout_canvas({ canvas_id, pattern: "hub_spoke" })
```

## Coordination
Agents coordinate via group project. PRs require approval from both QA (code quality) and UI Lead (design consistency) before merge. UI Lead delivers design specs as markdown docs, not code.
