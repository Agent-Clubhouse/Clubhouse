# UI Work

A three-agent pattern for implementation with design review and quality review.

## When to Use

- Frontend or visual changes that need design sign-off
- Component work, layout changes, or theme updates
- Any task where both visual correctness and code quality matter

## Canvas Layout

**Cards (3):**
- **Executor** — durable agent, implements the feature
- **QA** — durable agent, reviews code quality and test coverage
- **UI Lead** — durable agent, reviews visual/interaction design (specs, not code)

**Zones (1):**
- One zone containing all three agents

**Wires (2):**
- Executor → QA (code review)
- Executor → UI Lead (design review)
- QA and UI Lead are NOT wired to each other — they review independently

**Layout:** `hub_spoke` with executor as the hub

## MCP Tool Sequence

```
1. create_canvas(name: "UI Work")
2. add_card(type: "agent", name: "executor", role: "Frontend implementation")
3. add_card(type: "agent", name: "qa", role: "Code review and test verification")
4. add_card(type: "agent", name: "ui-lead", role: "Design review, specs only, no code")
5. add_zone(name: "UI Team", cards: [executor, qa, ui-lead])
6. add_wire(from: executor, to: qa, label: "PR review")
7. add_wire(from: executor, to: ui-lead, label: "Design review")
8. layout_canvas(pattern: "hub_spoke")
```

## Agent Instructions

**Executor:** Implement the feature following UI Lead's specs. Open PR when ready. Both QA and UI Lead must approve before merge.

**QA:** Review for code quality, test coverage, security (especially sanitizer changes). Binary approve/reject.

**UI Lead:** Review for visual correctness, design consistency, accessibility. Provide specs and SVG assets, not code. Approve or reject with design feedback.
