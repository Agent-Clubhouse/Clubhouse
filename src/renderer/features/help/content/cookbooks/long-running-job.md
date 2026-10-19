# Cookbook: Long-Running Job

## When to use
A single task that needs doing and reviewing, such as a bug fix, a feature or documentation. The simplest multi-agent pattern.

## Team
- **1 Developer** (Developer, can merge or Developer, opens PRs persona)
- **1 QA** (PR Reviewer persona)

## Canvas Layout

- 1 zone: "Job" containing both agents
- Developer -> QA wire (review flow)
- Layout: `horizontal`

## Blueprint JSON

```json
{
  "name": "Job",
  "zones": [{ "id": "z1", "name": "Job" }],
  "cards": [
    { "id": "exec", "type": "agent", "name": "Developer", "persona": "executor-merge", "zone": "z1" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa", "zone": "z1" }
  ],
  "wires": [
    { "from": "exec", "to": "qa" }
  ]
}
```

## Coordination
Two agents self-coordinate via direct wire. The developer sends progress and PR links. QA reviews. No coordinator needed.
