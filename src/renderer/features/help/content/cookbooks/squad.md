# Cookbook: Squad

## When to use
A focused team working on a single project, such as a feature sprint, a large refactor or new product development. The most common pattern for multi-agent work.

## Team
- **1 Coordinator** (Project Manager persona)
- **1 QA** (PR Reviewer persona)
- **Optional: 1 Design Lead** (Design Lead persona)
- **Optional: 1 Slop Detector** (AI Slop Detector persona)
- **N Workers** (Developer, can merge persona)
- **1 Group Project** card as the coordination hub

Scale N based on task parallelism. 3-5 workers is typical.

## Canvas Layout

- 1 group-project card: coordination hub (center)
- 1 agent card per role
- All agents connect to the group project card
- Layout: `hub_spoke`, with the group project at the center

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

Optional agents (Design Lead, AI Slop Detector) follow the same pattern. Add a card and wire it to the GP.

## GP Instructions
Default: "Coordinate squad work. Coordinator posts missions, workers report progress, QA reviews PRs. Use a work channel per mission and post decisions where the work happens."

## Coordination
All agents communicate via the group project bulletin board. A board starts with `general`, `control` and an inbox per member, and other channels appear when someone first posts to them. The coordinator announces work channels on `control`, posts a brief for each mission and tracks progress there. QA has veto power on merges. Workers: branch, implement, test, PR, standby.
