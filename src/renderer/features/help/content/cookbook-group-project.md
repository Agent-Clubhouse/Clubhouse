# Group Project

A multi-team pattern for coordinated work across separate Clubhouse projects, connected via a group project board.

## When to Use

- Work spanning two or more codebases or applications
- Cross-team coordination with shared milestones
- Microservice architectures or monorepo multi-package work

## Canvas Layout

**Cards (7+):**
- **Coordinator** — durable agent on standby, dispatches work and tracks progress
- **QA Lead** — durable agent, reviews PRs from both teams
- **Team A Workers (2)** — durable agents in Project A
- **Team B Workers (2)** — durable agents in Project B

**Zones (2):**
- **Zone A** — Team A workers, scoped to Project A
- **Zone B** — Team B workers, scoped to Project B

**Wires (4+):**
- Coordinator → Zone A (mission dispatch)
- Coordinator → Zone B (mission dispatch)
- Zone A workers → QA Lead (PR review)
- Zone B workers → QA Lead (PR review)

**Layout:** `grid` — coordinator and QA at top, two zones below

## MCP Tool Sequence

```
1. create_canvas(name: "Group Project")
2. add_card(type: "agent", name: "coordinator", role: "Project driver, dispatch only")
3. add_card(type: "agent", name: "qa-lead", role: "Cross-team quality gate")
4. add_card(type: "agent", name: "team-a-1", role: "Worker for Project A", project: projectA)
5. add_card(type: "agent", name: "team-a-2", role: "Worker for Project A", project: projectA)
6. add_card(type: "agent", name: "team-b-1", role: "Worker for Project B", project: projectB)
7. add_card(type: "agent", name: "team-b-2", role: "Worker for Project B", project: projectB)
8. add_zone(name: "Team A", cards: [team-a-1, team-a-2])
9. add_zone(name: "Team B", cards: [team-b-1, team-b-2])
10. add_wire(from: coordinator, to: team-a-1, label: "Dispatch")
11. add_wire(from: coordinator, to: team-b-1, label: "Dispatch")
12. add_wire(from: team-a-1, to: qa-lead, label: "PR review")
13. add_wire(from: team-b-1, to: qa-lead, label: "PR review")
14. layout_canvas(pattern: "grid")
```

## Agent Instructions

**Coordinator:** Plan work, break into missions, dispatch via group project board. Track progress, resolve blockers, make design decisions. Does not write code.

**QA Lead:** Review all PRs from both teams. Enforce green CI, test coverage, spec compliance. Binary approve/reject.

**Workers:** Pick up missions from the board, branch off main, implement, validate, open PR, post to progress. One mission per branch.
