# Cookbook: UI Work

## When to use
Tasks involving visual/interaction design alongside implementation — new UI features, design system changes, component overhauls.

## Team
- **1 Executor** (executor-merge persona)
- **1 QA** (qa persona)
- **1 UI Lead** (ui-lead persona)

QA and UI Lead operate independently — they don't review each other's work.

## Canvas Layout

- 1 zone: "UI Work" containing all agents
- Executor -> QA (code review), Executor -> UI Lead (design review)
- QA and UI Lead NOT wired to each other
- Layout: `hub_spoke` — executor at center

## Blueprint JSON

```json
{
  "name": "UI Work",
  "zones": [{ "id": "z1", "name": "UI Work" }],
  "cards": [
    { "id": "exec", "type": "agent", "name": "Executor", "persona": "executor-merge", "zone": "z1" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa", "zone": "z1" },
    { "id": "ui", "type": "agent", "name": "UI Lead", "persona": "ui-lead", "zone": "z1" }
  ],
  "wires": [
    { "from": "exec", "to": "qa" },
    { "from": "exec", "to": "ui" }
  ]
}
```

## Coordination
PRs require approval from both QA (code quality) and UI Lead (design consistency) before merge. UI Lead delivers design specs as markdown docs, not code.
