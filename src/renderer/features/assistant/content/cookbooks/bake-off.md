# Cookbook: Bake-Off

## When to use
A|B testing of two competing approaches to the same problem — architectural spikes, implementation comparisons, competing design directions. Two teams work independently, then judges evaluate. Useful when the best approach is unclear and you want to see both before committing.

## Team
- **1 Central Coordinator** — defines the challenge, sets rules, declares winner (project-manager persona)
- **2 Team Zones** (Alpha and Beta), each containing:
  - 1 Team Coordinator — manages their team's approach
  - 1 QA — reviews their team's PRs
  - N Workers — implement their team's solution (executor-pr-only, no merge — work stays on branches)
- **1-2 Judges** — evaluate both teams' output against criteria, connected to central coordinator

Workers use executor-pr-only (no merge) so competing approaches stay on separate branches until a winner is chosen.

## Canvas Layout

Cards:
- 1 agent card: Central Coordinator (top center)
- 1 zone card: "Team Alpha"
  - 1 agent card: Alpha Coordinator
  - 1 agent card: Alpha QA
  - N agent cards: Alpha Workers
- 1 zone card: "Team Beta"
  - 1 agent card: Beta Coordinator
  - 1 agent card: Beta QA
  - N agent cards: Beta Workers
- 1-2 agent cards: Judges

Wires:
- Central Coordinator -> Alpha Coordinator, Beta Coordinator (challenge dispatch)
- Alpha Coordinator -> Alpha Workers (mission dispatch within team)
- Beta Coordinator -> Beta Workers (mission dispatch within team)
- Alpha Workers -> Alpha QA (team-internal review)
- Beta Workers -> Beta QA (team-internal review)
- Alpha Coordinator -> Judge(s) (submit team output)
- Beta Coordinator -> Judge(s) (submit team output)
- Judge(s) -> Central Coordinator (verdict)

Layout: `grid` — central coordinator and judges on top row, two team zones side by side below.

## MCP Tool Sequence

```
1. create_canvas({ name: "<race-name> Bake-Off" })
2. add_card({ canvas_id, type: "agent", display_name: "Central Coordinator" })
3. add_card({ canvas_id, type: "agent", display_name: "Judge" })
4. add_card({ canvas_id, type: "zone", display_name: "Team Alpha" })
5. add_card({ canvas_id, type: "agent", display_name: "Alpha Coordinator" })
6. add_card({ canvas_id, type: "agent", display_name: "Alpha QA" })
7. add_card({ canvas_id, type: "agent", display_name: "Alpha Worker-1" })
8. add_card({ canvas_id, type: "agent", display_name: "Alpha Worker-2" })
9. add_card({ canvas_id, type: "zone", display_name: "Team Beta" })
10. add_card({ canvas_id, type: "agent", display_name: "Beta Coordinator" })
11. add_card({ canvas_id, type: "agent", display_name: "Beta QA" })
12. add_card({ canvas_id, type: "agent", display_name: "Beta Worker-1" })
13. add_card({ canvas_id, type: "agent", display_name: "Beta Worker-2" })
14. connect_cards — Central Coordinator -> Alpha Coordinator, Beta Coordinator
15. connect_cards — Alpha Coordinator -> Alpha Workers
16. connect_cards — Beta Coordinator -> Beta Workers
17. connect_cards — Alpha Workers -> Alpha QA
18. connect_cards — Beta Workers -> Beta QA
19. connect_cards — Alpha Coordinator -> Judge, Beta Coordinator -> Judge
20. connect_cards — Judge -> Central Coordinator
21. layout_canvas({ canvas_id, pattern: "grid" })
```

## Coordination
Central Coordinator posts the challenge spec to both teams simultaneously. Teams work independently — no cross-team communication. When both teams submit, judges evaluate against predefined criteria (performance, code quality, maintainability, test coverage). Central Coordinator merges the winning team's branch and closes the other.
