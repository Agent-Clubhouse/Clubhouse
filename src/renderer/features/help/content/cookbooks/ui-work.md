# Cookbook: UI Work

## When to use
Tasks that need visual and interaction design alongside implementation, such as new UI features, design system changes or component overhauls.

## Team
- **1 Developer** (Developer, can merge persona)
- **1 QA** (PR Reviewer persona)
- **1 Design Lead** (Design Lead persona)

QA and the Design Lead operate independently and don't review each other's work.

## Canvas Layout

- 1 zone: "UI Work" containing all agents
- Developer -> QA (code review), Developer -> Design Lead (design review)
- QA and the Design Lead are not wired to each other
- Layout: `hub_spoke`, with the developer at the center

## Blueprint JSON

```json
{
  "name": "UI Work",
  "zones": [{ "id": "z1", "name": "UI Work" }],
  "cards": [
    { "id": "exec", "type": "agent", "name": "Developer", "persona": "executor-merge", "zone": "z1" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa", "zone": "z1" },
    { "id": "ui", "type": "agent", "name": "Design Lead", "persona": "ui-lead", "zone": "z1" }
  ],
  "wires": [
    { "from": "exec", "to": "qa" },
    { "from": "exec", "to": "ui" }
  ]
}
```

## Coordination
PRs need approval from both QA (code quality) and the Design Lead (design consistency) before merge. The Design Lead delivers design specs as markdown docs and leaves production code to the developer.
