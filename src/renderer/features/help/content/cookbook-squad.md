# Squad

A focused team with a coordinator, quality gate, optional specialists, and N workers. All agents connect to a central group project card. The default pattern for multi-agent work.

## When to Use

- Feature development requiring 3+ agents
- Sprint-style work with multiple parallel missions
- Any project that benefits from coordination and quality enforcement

## Canvas Layout

**Cards (5+):**
- **Group Project** — coordination hub (center)
- **Coordinator** — plans and dispatches work (project-manager persona)
- **QA** — reviews all PRs (qa persona)
- **UI Lead** (optional) — design review (ui-lead persona)
- **Quality Auditor** (optional) — reviews AI-generated patterns (quality-auditor persona)
- **Workers (N)** — implementation with merge (executor-merge persona)

**Wires:** All agents → Group Project (bidirectional)

**Layout:** `hub_spoke` with group project as the hub

## Preferred: Blueprint API

Use `create_canvas_from_blueprint` with the squad blueprint JSON for atomic one-call setup. See the Squad cookbook in assistant content for the full blueprint.

## Scaling

- Add more workers by adding cards + wires to the GP
- Add UI Lead or Quality Auditor as additional agents wired to GP
- For large squads (6+ workers), consider splitting into zones with the Group Project (Multi-App) pattern

## Agent Instructions

**Coordinator:** Break work into well-scoped missions. Dispatch via group project board. Track progress, resolve blockers, make decisions. Does not write code.

**QA:** Final gate before merge. Verify green CI, test coverage, spec compliance. Reject with specific file:line feedback.

**Workers:** Pick up missions, branch off main, implement with tests, validate locally, open PR, post progress.
