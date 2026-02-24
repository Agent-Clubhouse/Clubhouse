# Clubhouse Mode

Clubhouse Mode keeps your durable agents in sync with project-level defaults. When enabled, changes to project settings (instructions, permissions, MCP config, skills, templates) are automatically pushed to agents on wake.

## How It Works

1. You configure project-level agent defaults (instructions, MCP, skills, etc.)
2. Clubhouse Mode pushes these defaults to durable agent worktrees
3. When an agent wakes and its config has drifted, a **Config Changes Dialog** appears

## Config Changes Dialog

When drift is detected, you see a diff grouped by category (instructions, permissions, MCP, skills, templates) with additions (+), removals (-), and modifications (~).

Three options:

| Action | Effect |
|--------|--------|
| **Save to Clubhouse** | Push selected changes back to project defaults |
| **Keep for this agent** | Lock the agent to its own config (override) |
| **Discard** | Ignore the changes |

## Wildcard Substitutions

Clubhouse Mode supports dynamic placeholders in instructions:

| Placeholder | Resolves To |
|------------|-------------|
| `@@AgentName` | The agent's display name |
| `@@StandbyBranch` | The agent's assigned branch |
| `@@Path` | The agent's worktree path |

> **Example:** An instruction file containing *"You are @@AgentName working on @@StandbyBranch"* resolves to *"You are feature-auth working on feature/auth-refactor"* for each agent.

## Settings

- **Global toggle:** **Settings > Clubhouse Mode** — enable/disable for all projects
- **Per-project override:** **Project Settings > Clubhouse Mode** — override the global setting

## When to Use

- **Teams** — Ensure all agents follow the same coding standards and instructions
- **Consistency** — Keep MCP servers, skills, and permissions uniform across agents
- **Flexibility** — Individual agents can still override with "Keep for this agent"
