# Cookbook: Group Project (Multi-App)

## When to use
Work spanning two separate applications or repositories — backend + frontend, library + consumers, or two microservices sharing a contract.

## Team
- **1 Coordinator** (project-manager persona)
- **1 QA** (qa persona) — reviews PRs across both apps
- **2 zones** with 2 workers each (executor-merge persona)
- **1 Group Project** card — coordination hub

Each zone maps to a separate Clubhouse project (separate git repo).

## Canvas Layout

- 1 group-project card: coordination hub
- 2 zones: "App A" and "App B" with 2 workers each
- All agents connect to the group project card
- Layout: `grid` — coordinator and QA top, zones below

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
Default: "Coordinate cross-app development. Coordinator dispatches missions, workers from each app report progress, QA reviews PRs from both. Topics: missions, progress, blockers, decisions."

## Coordination
All agents communicate via the group project bulletin board. Coordinator dispatches missions and resolves cross-app design decisions. QA reviews PRs from both apps.
