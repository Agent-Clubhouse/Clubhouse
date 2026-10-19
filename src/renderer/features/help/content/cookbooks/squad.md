# Cookbook: Squad

## When to use
A focused team working on a single project, such as a feature sprint, a large refactor or new product development. The most common pattern for multi-agent work.

## Team
- 1 lead using the Group Project Lead persona (`group-project-pm`)
- 1 PR Reviewer
- 1 Design Lead, if the work has UI
- 1 AI Slop Detector, if you want a cleanup pass
- N workers using the Developer (merges) persona
- 1 group project card as the coordination hub

Scale N based on task parallelism. 3-5 workers is typical.

## Canvas Layout

- 1 group project card at the center as the coordination hub
- 1 agent card per role
- All agents connect to the group project card
- Layout `hub_spoke`, with the group project at the center

## Blueprint JSON

Use `create_canvas_from_blueprint` for atomic creation:

```json
{
  "name": "Squad",
  "zones": [],
  "cards": [
    { "id": "gp", "type": "group-project", "name": "Coordination" },
    { "id": "lead", "type": "agent", "name": "Lead", "persona": "group-project-pm" },
    { "id": "qa", "type": "agent", "name": "PR Reviewer", "persona": "qa" },
    { "id": "w1", "type": "agent", "name": "Worker-1", "persona": "executor-merge" },
    { "id": "w2", "type": "agent", "name": "Worker-2", "persona": "executor-merge" },
    { "id": "w3", "type": "agent", "name": "Worker-3", "persona": "executor-merge" }
  ],
  "wires": [
    { "from": "lead", "to": "gp", "bidirectional": true },
    { "from": "qa", "to": "gp", "bidirectional": true },
    { "from": "w1", "to": "gp", "bidirectional": true },
    { "from": "w2", "to": "gp", "bidirectional": true },
    { "from": "w3", "to": "gp", "bidirectional": true }
  ]
}
```

Optional agents (Design Lead, AI Slop Detector) follow the same pattern. Add a card and wire it to the GP.

## GP Instructions
The default is "Coordinate squad work. The lead posts missions, workers report progress, PR Reviewer reviews PRs. Use a work channel per mission and post decisions where the work happens."

## Coordination
All agents communicate via the group project bulletin board. A board starts with `general`, `control` and an inbox per member, and other channels appear when someone first posts to them. The lead announces work channels on `control`, posts a brief for each mission and tracks progress there. Wire the lead to the group project first, because the first agent to join becomes the project's admin and gets the tools to wake, sleep and poll the team. Workers branch, implement, test and open a PR. A worker merges once the PR Reviewer approves the latest push and CI is green, then returns to standby.
