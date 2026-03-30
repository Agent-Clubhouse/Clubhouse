# Cookbook: Group Project (Multi-App)

## When to use
Work spanning two separate applications or repositories that need coordinated development — e.g., a backend API and frontend client, a library and its consumers, or two microservices that share a contract.

## Team
- **1 Coordinator** — plans work, dispatches missions, makes decisions (project-manager persona)
- **1 QA** — reviews PRs across both apps (qa persona)
- **2 zones** with 2 workers each (4 executors total, executor-merge persona)

Each zone maps to a separate Clubhouse project (separate git repo).

## Canvas Layout

Cards:
- 1 plugin card: Group Project (coordination hub)
- 1 agent card: Coordinator (project-manager persona)
- 1 agent card: QA (qa persona)
- 1 zone card: "App A" (contains 2 executor agents)
- 2 agent cards inside App A zone: Worker-A1, Worker-A2
- 1 zone card: "App B" (contains 2 executor agents)
- 2 agent cards inside App B zone: Worker-B1, Worker-B2

Wires:
- All agents -> Group Project card (bulletin board coordination)

Layout: `grid` — coordinator and QA on top row, two zones side by side below.

## MCP Tool Sequence

```
1. create_canvas({ name: "<project-name> Multi-App" })
2. add_card({ canvas_id, type: "plugin", display_name: "Group Project" })
3. create_agent({ project_path: app_a_path, name: "Coordinator", persona: "project-manager" })
4. add_card({ canvas_id, type: "agent", agent_id: coordinator_id, project_id: app_a_project_id })
5. create_agent({ project_path: app_a_path, name: "QA", persona: "qa" })
6. add_card({ canvas_id, type: "agent", agent_id: qa_id, project_id: app_a_project_id })
7. add_card({ canvas_id, type: "zone", display_name: "App A" })
8. create_agent({ project_path: app_a_path, name: "Worker-A1", persona: "executor-merge" })
9. add_card({ canvas_id, type: "agent", agent_id: worker_a1_id, project_id: app_a_project_id, zone_id: app_a_zone_id })
10. create_agent({ project_path: app_a_path, name: "Worker-A2", persona: "executor-merge" })
11. add_card({ canvas_id, type: "agent", agent_id: worker_a2_id, project_id: app_a_project_id, zone_id: app_a_zone_id })
12. add_card({ canvas_id, type: "zone", display_name: "App B" })
13. create_agent({ project_path: app_b_path, name: "Worker-B1", persona: "executor-merge" })
14. add_card({ canvas_id, type: "agent", agent_id: worker_b1_id, project_id: app_b_project_id, zone_id: app_b_zone_id })
15. create_agent({ project_path: app_b_path, name: "Worker-B2", persona: "executor-merge" })
16. add_card({ canvas_id, type: "agent", agent_id: worker_b2_id, project_id: app_b_project_id, zone_id: app_b_zone_id })
17. connect_cards — each agent card -> Group Project card
18. layout_canvas({ canvas_id, pattern: "grid" })
```

## Coordination
All agents communicate via the group project bulletin board. Coordinator dispatches missions and resolves cross-app design decisions. Each zone's workers operate on their respective Clubhouse project. QA reviews PRs from both apps.
