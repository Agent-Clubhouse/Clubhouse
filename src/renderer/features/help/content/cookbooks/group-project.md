# Cookbook: Group Project (Multi-App)

## When to use
Work spanning two separate applications or repositories, such as backend and frontend, a library and its consumers, or two microservices sharing a contract.

## Team
- **1 Coordinator** (Project Manager persona)
- **1 QA** (PR Reviewer persona), who reviews PRs across both apps
- **2 zones** with 2 workers each (Developer, can merge persona)
- **1 Group Project** card as the coordination hub

Each zone maps to a separate Clubhouse project (separate git repo).

## Canvas Layout

- 1 group-project card: coordination hub
- 2 zones: "App A" and "App B" with 2 workers each
- All agents connect to the group project card
- Layout: `grid`, with the coordinator and QA on top and the zones below

## Blueprint JSON

```json
{
  "name": "Multi-App",
  "zones": [
    { "id": "z-a", "name": "App A" },
    { "id": "z-b", "name": "App B" }
  ],
  "cards": [
    { "id": "gp", "type": "group-project", "name": "Coordination" },
    { "id": "coord", "type": "agent", "name": "Coordinator", "persona": "project-manager" },
    { "id": "qa", "type": "agent", "name": "QA", "persona": "qa" },
    { "id": "wa1", "type": "agent", "name": "Worker-A1", "persona": "executor-merge", "zone": "z-a" },
    { "id": "wa2", "type": "agent", "name": "Worker-A2", "persona": "executor-merge", "zone": "z-a" },
    { "id": "wb1", "type": "agent", "name": "Worker-B1", "persona": "executor-merge", "zone": "z-b" },
    { "id": "wb2", "type": "agent", "name": "Worker-B2", "persona": "executor-merge", "zone": "z-b" }
  ],
  "wires": [
    { "from": "coord", "to": "gp", "bidirectional": true },
    { "from": "qa", "to": "gp", "bidirectional": true },
    { "from": "wa1", "to": "gp", "bidirectional": true },
    { "from": "wa2", "to": "gp", "bidirectional": true },
    { "from": "wb1", "to": "gp", "bidirectional": true },
    { "from": "wb2", "to": "gp", "bidirectional": true }
  ]
}
```

## GP Instructions
Default: "Coordinate cross-app development. Coordinator dispatches missions, workers from each app report progress, QA reviews PRs from both. Use a work channel per mission and post decisions where the work happens."

## Coordination
All agents communicate via the group project bulletin board. A board starts with `general`, `control` and an inbox per member; other channels appear when someone first posts to them. Coordinator dispatches missions and resolves cross-app design decisions. QA reviews PRs from both apps.
