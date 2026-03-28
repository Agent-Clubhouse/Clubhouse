# Drag Race

A competitive pattern where two teams independently implement the same spec, and judges select the winner. Useful for exploring different approaches to a problem.

## When to Use

- Exploring multiple architectural approaches to the same problem
- A/B testing implementations before committing to one
- High-stakes decisions where you want to compare real code, not just plans
- Creative work where diverse approaches produce better outcomes

## Canvas Layout

**Cards (10+):**
- **Central Coordinator** — dispatches the same spec to both teams, collects results
- **Alpha Coordinator** — leads Team Alpha's approach
- **Alpha QA** — reviews Alpha's PRs
- **Alpha Workers (2+)** — implementation agents (no merge, PRs only)
- **Beta Coordinator** — leads Team Beta's approach
- **Beta QA** — reviews Beta's PRs
- **Beta Workers (2+)** — implementation agents (no merge, PRs only)
- **Judges (1-2)** — evaluate both teams' output, report to central coordinator

**Zones (2):**
- **Zone Alpha** — Alpha coordinator, QA, and workers
- **Zone Beta** — Beta coordinator, QA, and workers

**Wires:**
- Central Coordinator → Alpha Coordinator (spec dispatch)
- Central Coordinator → Beta Coordinator (spec dispatch)
- Alpha Workers → Alpha QA (PR review within team)
- Beta Workers → Beta QA (PR review within team)
- Alpha Coordinator → Judges (submission)
- Beta Coordinator → Judges (submission)
- Judges → Central Coordinator (verdict)

**Layout:** `grid` — central coordinator and judges at top, two team zones below

## MCP Tool Sequence

```
1. create_canvas(name: "Drag Race")
2. add_card(type: "agent", name: "central-coordinator", role: "Dispatch spec, collect verdicts")
3. add_card(type: "agent", name: "judge", role: "Evaluate both implementations")
4. add_card(type: "agent", name: "alpha-coord", role: "Team Alpha lead")
5. add_card(type: "agent", name: "alpha-qa", role: "Team Alpha quality gate")
6. add_card(type: "agent", name: "alpha-1", role: "Alpha worker, PR only, no merge")
7. add_card(type: "agent", name: "alpha-2", role: "Alpha worker, PR only, no merge")
8. add_card(type: "agent", name: "beta-coord", role: "Team Beta lead")
9. add_card(type: "agent", name: "beta-qa", role: "Team Beta quality gate")
10. add_card(type: "agent", name: "beta-1", role: "Beta worker, PR only, no merge")
11. add_card(type: "agent", name: "beta-2", role: "Beta worker, PR only, no merge")
12. add_zone(name: "Team Alpha", cards: [alpha-coord, alpha-qa, alpha-1, alpha-2])
13. add_zone(name: "Team Beta", cards: [beta-coord, beta-qa, beta-1, beta-2])
14. add_wire(from: central-coordinator, to: alpha-coord, label: "Spec")
15. add_wire(from: central-coordinator, to: beta-coord, label: "Spec")
16. add_wire(from: alpha-1, to: alpha-qa, label: "PR review")
17. add_wire(from: beta-1, to: beta-qa, label: "PR review")
18. add_wire(from: alpha-coord, to: judge, label: "Alpha submission")
19. add_wire(from: beta-coord, to: judge, label: "Beta submission")
20. add_wire(from: judge, to: central-coordinator, label: "Verdict")
21. layout_canvas(pattern: "grid")
```

## Key Rules

- **Workers have no merge permission.** Only the central coordinator merges the winning implementation after judges decide.
- **Teams work independently.** No cross-team communication during the race.
- **Judges evaluate on predefined criteria:** code quality, test coverage, architecture, performance, and spec compliance. Provide the rubric upfront.

## Agent Instructions

**Central Coordinator:** Write the spec with clear acceptance criteria and evaluation rubric. Dispatch to both team coordinators simultaneously. After both submit, ask judges to evaluate. Merge the winner.

**Team Coordinators:** Break the spec into tasks for your workers. Make architectural decisions for your team. Submit your team's work when ready.

**Workers:** Implement assigned tasks, open PRs to your team's branch (not main). No merge.

**Judges:** Compare both implementations against the rubric. Provide a structured verdict with scores per criterion. Recommend a winner with reasoning.
