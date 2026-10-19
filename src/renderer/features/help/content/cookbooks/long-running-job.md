# Cookbook: Long-Running Job

## When to use
A single task that needs doing and reviewing, such as a bug fix, a feature or documentation. The simplest multi-agent pattern.

## Team
- 1 developer using the Developer (merges) or Developer persona
- 1 PR Reviewer

## Canvas Layout

- 1 zone, "Job", containing both agents
- Developer -> PR Reviewer wire (review flow)
- Layout `horizontal`

## Blueprint JSON

```json
{
  "name": "Job",
  "zones": [{ "id": "z1", "name": "Job" }],
  "cards": [
    { "id": "exec", "type": "agent", "name": "Developer", "persona": "executor-merge", "zone": "z1" },
    { "id": "qa", "type": "agent", "name": "PR Reviewer", "persona": "qa", "zone": "z1" }
  ],
  "wires": [
    { "from": "exec", "to": "qa" }
  ]
}
```

## Coordination
Two agents self-coordinate via direct wire. The developer sends progress and PR links. PR Reviewer reviews. No coordinator needed.
