# Cookbook: Squad

## When to use
A focused team working on a single project with coordinated planning — feature sprints, large refactors, new product development. The most common pattern for serious multi-agent work.

## Team
- **1 Coordinator** — plans, dispatches, tracks progress (project-manager persona)
- **1 QA** — reviews all PRs, enforces quality bar (qa persona)
- **Optional: 1 UI Lead** — visual/interaction design (ui-lead persona)
- **Optional: 1 Slop Detector** — reviews for AI-generated anti-patterns (slop-detector persona)
- **N Workers** — implementation agents with merge permission (executor-merge persona)

Scale N based on task parallelism. 3-5 workers is typical.

## Canvas Layout

Cards:
- 1 agent card: Coordinator (center hub)
- 1 agent card: QA
- 0-1 agent card: UI Lead (optional)
- 0-1 agent card: Slop Detector (optional)
- N agent cards: Workers (executor-merge)

Wires:
- Coordinator -> each Worker (mission dispatch)
- Each Worker -> QA (PR review)
- Each Worker -> UI Lead (if present, design review for UI-touching PRs)
- Each Worker -> Slop Detector (if present, quality review)

Layout: `hub_spoke` — coordinator at center, all other agents arranged in a circle.

## MCP Tool Sequence

```
1. create_canvas({ name: "<squad-name>" })
2. add_card({ canvas_id, type: "agent", display_name: "Coordinator" })
3. add_card({ canvas_id, type: "agent", display_name: "QA" })
4. add_card({ canvas_id, type: "agent", display_name: "UI Lead" })       # optional
5. add_card({ canvas_id, type: "agent", display_name: "Slop Detector" }) # optional
6. add_card({ canvas_id, type: "agent", display_name: "Worker-1" })
7. add_card({ canvas_id, type: "agent", display_name: "Worker-2" })
8. add_card({ canvas_id, type: "agent", display_name: "Worker-3" })
   ... repeat for N workers
9. connect_cards — coordinator -> each worker
10. connect_cards — each worker -> QA
11. connect_cards — each worker -> UI Lead (if present)
12. connect_cards — each worker -> Slop Detector (if present)
13. layout_canvas({ canvas_id, pattern: "hub_spoke" })
```

## Coordination
Coordinator owns the group project bulletin board. Posts mission briefs to `missions` topic, tracks progress via `progress` topic, resolves blockers via `blockers` topic. QA has veto power on merges. Workers operate autonomously within their assigned missions: branch, implement, test, PR, standby.
