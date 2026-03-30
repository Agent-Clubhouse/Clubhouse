# Squad

A flexible team pattern with a coordinator, quality gate, optional specialists, and N workers. The default pattern for most multi-agent work.

## When to Use

- Feature development requiring 3+ agents
- Sprint-style work with multiple parallel missions
- Any project that benefits from coordination and quality enforcement

## Canvas Layout

**Cards (5+):**
- **Coordinator** — durable agent, plans and dispatches work
- **QA** — durable agent, reviews all PRs
- **UI Lead** (optional) — durable agent, design review for visual work
- **Quality Auditor** (optional) — durable agent, reviews for AI-generated patterns
- **Workers (N)** — durable agents with merge permission

**Zones (1):**
- One zone containing all workers

**Wires:**
- Coordinator → each worker (mission dispatch)
- Each worker → QA (PR review)
- Each worker → UI Lead (if present, design review)
- Coordinator → QA (approval authority)

**Layout:** `hub_spoke` with coordinator as the hub

## MCP Tool Sequence

```
1. create_canvas(name: "Squad")
2. add_card(type: "agent", name: "coordinator", role: "Project driver, planning and dispatch")
3. add_card(type: "agent", name: "qa", role: "Quality gate, approve/reject PRs")
4. add_card(type: "agent", name: "worker-1", role: "Implementation with merge")
5. add_card(type: "agent", name: "worker-2", role: "Implementation with merge")
6. add_card(type: "agent", name: "worker-3", role: "Implementation with merge")
7. add_zone(name: "Workers", cards: [worker-1, worker-2, worker-3])
8. add_wire(from: coordinator, to: worker-1, label: "Dispatch")
9. add_wire(from: coordinator, to: worker-2, label: "Dispatch")
10. add_wire(from: coordinator, to: worker-3, label: "Dispatch")
11. add_wire(from: worker-1, to: qa, label: "PR review")
12. add_wire(from: worker-2, to: qa, label: "PR review")
13. add_wire(from: worker-3, to: qa, label: "PR review")
14. layout_canvas(pattern: "hub_spoke")
```

## Scaling

- Add more workers by repeating the add_card + add_wire pattern
- Add UI Lead or Quality Auditor as additional hub spokes wired from workers
- For large squads (6+ workers), consider splitting into two zones with the Group Project pattern instead

## Agent Instructions

**Coordinator:** Break work into well-scoped missions. Dispatch via group project board. Track progress, resolve blockers, make decisions. Does not write code.

**QA:** Final gate before merge. Verify green CI, test coverage, spec compliance. Reject with specific file:line feedback.

**Workers:** Pick up missions, branch off main, implement with tests, validate locally, open PR, post progress. Rebase between merges.
