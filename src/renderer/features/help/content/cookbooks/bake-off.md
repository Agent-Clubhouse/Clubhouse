# Cookbook: Bake-Off

## When to use
A|B testing of two competing approaches. Two teams work independently, then judges evaluate. Useful when the best approach is unclear.

## Team
- 1 central coordinator using the Group Project Lead persona (`group-project-pm`), who defines the challenge and declares the winner
- Team Alpha, with a lead (Group Project Lead), a PR Reviewer and N workers (Developer)
- Team Beta, with the same roles as Team Alpha
- 1 judge using the PR Reviewer persona, who reviews both teams' output against the same criteria
- 3 group projects, one per team and one for judging
- 3 zones, Alpha (cyan), Beta (rose) and Judging (violet)

Workers use the Developer persona (`executor-pr-only`), which opens PRs without merging, so competing approaches stay on branches until a winner is chosen.

## Canvas Layout

- 3 named colored zones containing their respective teams
- Central Coordinator direct-connects to Alpha Lead + Beta Lead
- Each team communicates via its own GP
- Judge + Coordinator share the Judging GP
- Layout `grid`, with the judging zone on top and the team zones side by side below

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
    { "id": "alpha-lead", "type": "agent", "name": "Alpha Lead", "persona": "group-project-pm", "zone": "z-alpha" },
    { "id": "alpha-qa", "type": "agent", "name": "Alpha PR Reviewer", "persona": "qa", "zone": "z-alpha" },
    { "id": "alpha-w1", "type": "agent", "name": "Alpha Worker-1", "persona": "executor-pr-only", "zone": "z-alpha" },
    { "id": "gp-beta", "type": "group-project", "name": "Beta Team GP", "zone": "z-beta" },
    { "id": "beta-lead", "type": "agent", "name": "Beta Lead", "persona": "group-project-pm", "zone": "z-beta" },
    { "id": "beta-qa", "type": "agent", "name": "Beta PR Reviewer", "persona": "qa", "zone": "z-beta" },
    { "id": "beta-w1", "type": "agent", "name": "Beta Worker-1", "persona": "executor-pr-only", "zone": "z-beta" },
    { "id": "gp-judging", "type": "group-project", "name": "Judging GP", "zone": "z-judge" },
    { "id": "coordinator", "type": "agent", "name": "Central Coordinator", "persona": "group-project-pm", "zone": "z-judge" },
    { "id": "judge", "type": "agent", "name": "Judge", "persona": "qa", "zone": "z-judge" }
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
- Alpha Team GP says "Alpha team builds a competing implementation. The lead dispatches, workers implement, the PR Reviewer reviews. Post progress and PRs."
- Beta Team GP says the same for the Beta team.
- Judging GP says "Evaluate Alpha vs Beta output. Judge checks each team's PR on its own first, giving pass or fail per criterion with evidence such as a test run, file or command output. Only then does Judge compare them and recommend one, so the order they arrive in and how long they are don't sway the pick. Coordinator declares the winner and asks the user to merge it."

## Coordination
Central Coordinator posts the challenge spec to both leads. Teams work independently and don't talk to each other. When both submit, Judge evaluates via the Judging GP. Coordinator declares the winner and asks the user, with `notify_user`, to merge the winning PR once CI is green.
