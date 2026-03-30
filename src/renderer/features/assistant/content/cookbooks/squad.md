# Cookbook: Squad

## When to use
A focused team working on a single project with coordinated planning — feature sprints, large refactors, new product development. The most common pattern for serious multi-agent work.

## Team
- **1 Coordinator** — plans, dispatches, tracks progress (project-manager persona)
- **1 QA** — reviews all PRs, enforces quality bar (qa persona)
- **Optional: 1 UI Lead** — visual/interaction design (ui-lead persona)
- **Optional: 1 Quality Auditor** — reviews for AI-generated anti-patterns (quality-auditor persona)
- **N Workers** — implementation agents with merge permission (executor-merge persona)

Scale N based on task parallelism. 3-5 workers is typical.

## Canvas Layout

Cards:
- 1 plugin card: Group Project (coordination hub, center)
- 1 agent card: Coordinator (project-manager persona)
- 1 agent card: QA (qa persona)
- 0-1 agent card: UI Lead (optional, ui-lead persona)
- 0-1 agent card: Quality Auditor (optional, quality-auditor persona)
- N agent cards: Workers (executor-merge persona)

Wires:
- All agents -> Group Project card (bulletin board coordination)

Layout: `hub_spoke` — group project card at center, all agents arranged around it.

## MCP Tool Sequence

```
1. create_canvas({ name: "<squad-name>" })
2. add_card({ canvas_id, type: "plugin", display_name: "Group Project" })
3. create_agent({ project_path, name: "Coordinator", persona: "project-manager" })
4. add_card({ canvas_id, type: "agent", agent_id: coordinator_id, project_id })
5. create_agent({ project_path, name: "QA", persona: "qa" })
6. add_card({ canvas_id, type: "agent", agent_id: qa_id, project_id })
7. create_agent({ project_path, name: "Worker-1", persona: "executor-merge" })
8. add_card({ canvas_id, type: "agent", agent_id: worker1_id, project_id })
   ... repeat for N workers
9. connect_cards — each agent card -> Group Project card
10. layout_canvas({ canvas_id, pattern: "hub_spoke" })
```

Optional agents (UI Lead with `persona: "ui-lead"`, Quality Auditor with `persona: "quality-auditor"`) follow the same create_agent + add_card + connect_cards pattern.

## Coordination
All agents communicate via the group project bulletin board. Coordinator posts mission briefs to `missions` topic, tracks progress via `progress` topic, resolves blockers via `blockers` topic. QA has veto power on merges. Workers operate autonomously within their assigned missions: branch, implement, test, PR, standby.
