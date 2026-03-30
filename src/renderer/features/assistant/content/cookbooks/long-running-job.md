# Cookbook: Long-Running Job

## When to use
A single task needing execution and quality review — bug fixes, features, documentation. The simplest multi-agent pattern.

## Team
- **1 Executor** (executor-merge or executor-pr-only persona)
- **1 QA** (qa persona)

## Canvas Layout

- 1 zone: "Job" containing both agents
- Executor -> QA wire (review flow)
- Layout: `horizontal`

## Blueprint JSON

```json
{
  "name": "Job",
  "zones": [{ "id": "z1", "name": "Job" }],
  "cards": [
    { "id": "exec", "type": "agent", "name": "Executor", "persona": "executor-merge", "zone": "z1" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa", "zone": "z1" }
  ],
  "wires": [
    { "from": "exec", "to": "qa" }
  ]
}
```

## Coordination
Two agents self-coordinate via direct wire. Executor posts progress and PR links. QA reviews. No coordinator needed.
