# Long-Running Job

A minimal two-agent pattern for executing a task with quality review.

## When to Use

- Single focused task that takes more than a few minutes
- Bug fixes, feature implementations, or refactors with clear scope
- You want a safety net before merging

## Canvas Layout

**Cards (2):**
- **Executor** — durable agent with merge permission, does the implementation work
- **QA** — durable agent, reviews the executor's PR before merge

**Zones (1):**
- One zone containing both agents

**Wires (1):**
- Executor → QA (via group project board)

**Layout:** `horizontal` — two cards side by side

## MCP Tool Sequence

```
1. create_canvas(name: "Long-Running Job")
2. add_card(type: "agent", name: "executor", role: "Implementation worker with merge")
3. add_card(type: "agent", name: "qa", role: "Code reviewer, approve/reject only")
4. add_zone(name: "Job", cards: [executor, qa])
5. add_wire(from: executor, to: qa, label: "PR review")
6. layout_canvas(pattern: "horizontal")
```

## Agent Instructions

**Executor:** Branch off main, implement the task, write tests, validate, open PR. Post to group project board when ready for review.

**QA:** Watch for PRs from the executor. Review against spec, verify tests, check CI. Approve or reject with specific feedback.
