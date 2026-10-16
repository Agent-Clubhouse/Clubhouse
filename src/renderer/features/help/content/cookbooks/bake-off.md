# Cookbook: Bake-Off

## When to use
A|B testing of two competing approaches. Two teams work independently, then judges evaluate. Useful when the best approach is unclear.

## Team
- **1 Central Coordinator** (project-manager persona) — defines challenge, declares winner
- **Team Alpha**: 1 Lead + 1 QA + N Workers (executor-pr-only, no merge)
- **Team Beta**: 1 Lead + 1 QA + N Workers (executor-pr-only, no merge)
- **1 Judge** (judge persona) — evaluates both teams' output
- **3 Group Projects**: Alpha Team GP, Beta Team GP, Judging GP
- **3 Zones**: Alpha (cyan), Beta (rose), Judging (violet)

Workers use executor-pr-only so competing approaches stay on branches until a winner is chosen.

## Canvas Layout

- 3 named colored zones containing their respective teams
- Central Coordinator direct-connects to Alpha Lead + Beta Lead
- Each team communicates via its own GP
- Judge + Coordinator share the Judging GP
- Layout: `grid` — judging zone top, team zones side by side below

## Blueprint JSON

Use `create_canvas_from_blueprint` for atomic creation:

```json
{
  "name": "Bake-Off",
  "zones": [
    { "id": "z-alpha", "name": "Team Alpha", "color": "cyan" },
    { "id": "z-beta", "name": "Team Beta", "color": "rose" },
    { "id": "z-judge", "name": "Judging", "color": "violet" }
  ],
  "cards": [
    { "id": "gp-alpha", "type": "group-project", "name": "Alpha Team GP", "zone": "z-alpha" },
    { "id": "alpha-lead", "type": "agent", "name": "Alpha Lead", "persona": "project-manager", "zone": "z-alpha" },
    { "id": "alpha-qa", "type": "agent", "name": "Alpha QA", "persona": "qa", "zone": "z-alpha" },
    { "id": "alpha-w1", "type": "agent", "name": "Alpha Worker-1", "persona": "executor-pr-only", "zone": "z-alpha" },
    { "id": "gp-beta", "type": "group-project", "name": "Beta Team GP", "zone": "z-beta" },
    { "id": "beta-lead", "type": "agent", "name": "Beta Lead", "persona": "project-manager", "zone": "z-beta" },
    { "id": "beta-qa", "type": "agent", "name": "Beta QA", "persona": "qa", "zone": "z-beta" },
    { "id": "beta-w1", "type": "agent", "name": "Beta Worker-1", "persona": "executor-pr-only", "zone": "z-beta" },
    { "id": "gp-judging", "type": "group-project", "name": "Judging GP", "zone": "z-judge" },
    { "id": "coordinator", "type": "agent", "name": "Central Coordinator", "persona": "project-manager", "zone": "z-judge" },
    { "id": "judge", "type": "agent", "name": "Judge", "persona": "judge", "zone": "z-judge" }
  ],
  "wires": [
    { "from": "alpha-lead", "to": "gp-alpha", "bidirectional": true },
    { "from": "alpha-qa", "to": "gp-alpha", "bidirectional": true },
    { "from": "alpha-w1", "to": "gp-alpha", "bidirectional": true },
    { "from": "beta-lead", "to": "gp-beta", "bidirectional": true },
    { "from": "beta-qa", "to": "gp-beta", "bidirectional": true },
    { "from": "beta-w1", "to": "gp-beta", "bidirectional": true },
    { "from": "coordinator", "to": "gp-judging", "bidirectional": true },
    { "from": "judge", "to": "gp-judging", "bidirectional": true },
    { "from": "coordinator", "to": "alpha-lead" },
    { "from": "coordinator", "to": "beta-lead" }
  ]
}
```

## GP Instructions
- **Alpha Team GP**: "Alpha team builds competing implementation. Lead dispatches, workers implement, QA reviews. Post progress and PRs."
- **Beta Team GP**: "Beta team builds competing implementation. Lead dispatches, workers implement, QA reviews. Post progress and PRs."
- **Judging GP**: "Evaluate Alpha vs Beta output. Judge scores against criteria. Coordinator declares winner and merges."

## Coordination
Central Coordinator posts the challenge spec to both leads. Teams work independently — no cross-team communication. When both submit, Judge evaluates via the Judging GP. Coordinator merges the winner's branch.
