# Cookbook: Group Project (Multi-App)

## When to use
Work spanning two separate applications or repositories that need coordinated development — e.g., a backend API and frontend client, a library and its consumers, or two microservices that share a contract.

## Team
- **1 Coordinator** — plans work, dispatches missions, makes decisions (project-manager persona)
- **1 QA** — reviews PRs across both apps
- **2 zones** with 2 workers each (4 executors total)

Each zone maps to a separate Clubhouse project (separate git repo).

## Canvas Layout

Cards:
- 1 agent card: Coordinator (type: agent, project-manager persona)
- 1 agent card: QA (type: agent, qa persona)
- 1 zone card: "App A" (contains 2 executor agents)
- 2 agent cards inside App A zone: Worker-A1, Worker-A2
- 1 zone card: "App B" (contains 2 executor agents)
- 2 agent cards inside App B zone: Worker-B1, Worker-B2

Wires:
- Coordinator -> Worker-A1, Worker-A2, Worker-B1, Worker-B2 (dispatches work)
- Worker-A1 -> QA, Worker-A2 -> QA, Worker-B1 -> QA, Worker-B2 -> QA (PR review)

Layout: `grid` — coordinator and QA on top row, two zones side by side below.

## MCP Tool Sequence

```
1. create_canvas({ name: "<project-name> Multi-App" })
2. add_card({ canvas_id, type: "agent", display_name: "Coordinator" })
3. add_card({ canvas_id, type: "agent", display_name: "QA" })
4. add_card({ canvas_id, type: "zone", display_name: "App A" })
5. add_card({ canvas_id, type: "agent", display_name: "Worker-A1" })
6. add_card({ canvas_id, type: "agent", display_name: "Worker-A2" })
7. add_card({ canvas_id, type: "zone", display_name: "App B" })
8. add_card({ canvas_id, type: "agent", display_name: "Worker-B1" })
9. add_card({ canvas_id, type: "agent", display_name: "Worker-B2" })
10. connect_cards({ canvas_id, from_card_id: coordinator_id, to_card_id: worker_a1_id })
11. connect_cards({ canvas_id, from_card_id: coordinator_id, to_card_id: worker_a2_id })
12. connect_cards({ canvas_id, from_card_id: coordinator_id, to_card_id: worker_b1_id })
13. connect_cards({ canvas_id, from_card_id: coordinator_id, to_card_id: worker_b2_id })
14. connect_cards({ canvas_id, from_card_id: worker_a1_id, to_card_id: qa_id })
15. connect_cards({ canvas_id, from_card_id: worker_a2_id, to_card_id: qa_id })
16. connect_cards({ canvas_id, from_card_id: worker_b1_id, to_card_id: qa_id })
17. connect_cards({ canvas_id, from_card_id: worker_b2_id, to_card_id: qa_id })
18. layout_canvas({ canvas_id, pattern: "grid" })
```

## Coordination
Coordinator dispatches missions via group project bulletin board. Each zone's workers operate on their respective Clubhouse project. QA reviews PRs from both apps. Coordinator resolves cross-app design decisions and contract changes.
