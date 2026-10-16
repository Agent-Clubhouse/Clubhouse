# Cookbook: Squad

## When to use
A focused team working on a single project — feature sprints, large refactors, new product development. The most common pattern for multi-agent work.

## Team
- **1 Coordinator** (project-manager persona)
- **1 QA** (qa persona)
- **Optional: 1 UI Lead** (ui-lead persona)
- **Optional: 1 Quality Auditor** (quality-auditor persona)
- **N Workers** (executor-merge persona)
- **1 Group Project** card — coordination hub

Scale N based on task parallelism. 3-5 workers is typical.

## Canvas Layout

- 1 group-project card: coordination hub (center)
- 1 agent card per role
- All agents connect to the group project card
- Layout: `hub_spoke` — group project at center

## Blueprint JSON

Use `create_canvas_from_blueprint` for atomic creation:

```json
{
  "name": "Squad",
  "zones": [],
  "cards": [
    { "id": "gp", "type": "group-project", "name": "Coordination" },
    { "id": "coord", "type": "agent", "name": "Coordinator", "persona": "project-manager" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa" },
    { "id": "w1", "type": "agent", "name": "Worker-1", "persona": "executor-merge" },
    { "id": "w2", "type": "agent", "name": "Worker-2", "persona": "executor-merge" },
    { "id": "w3", "type": "agent", "name": "Worker-3", "persona": "executor-merge" }
  ],
  "wires": [
    { "from": "coord", "to": "gp", "bidirectional": true },
    { "from": "qa", "to": "gp", "bidirectional": true },
    { "from": "w1", "to": "gp", "bidirectional": true },
    { "from": "w2", "to": "gp", "bidirectional": true },
    { "from": "w3", "to": "gp", "bidirectional": true }
  ]
}
```

Optional agents (UI Lead, Quality Auditor) follow the same pattern — add card + wire to GP.

## GP Instructions
Default: "Coordinate squad work. Coordinator posts missions, workers report progress, QA reviews PRs. Topics: missions, progress, blockers, decisions."

## Coordination
All agents communicate via the group project bulletin board. Coordinator posts mission briefs to `missions`, tracks `progress`, resolves `blockers`. QA has veto power on merges. Workers: branch, implement, test, PR, standby.
