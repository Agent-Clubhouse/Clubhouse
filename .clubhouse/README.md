# .clubhouse/

This directory is managed by [Clubhouse](https://github.com/Clubhouse) — a multi-agent manager for Claude Code.

## Directory Structure

### Tracked (committed to git)
- `settings.json` — Project-level defaults for all agents (CLAUDE.md template, permissions, MCP config)
- `skills/` — Shared Claude Code skills available to all agents
- `notes/` — Project notes accessible to agents
- `README.md` — This file

### Gitignored (machine-local)
- `agents/` — Git worktrees for each durable agent
- `.local/` — Legacy local-only agent worktrees
- `agents.json` — Agent registry (IDs, names, branches, overrides)
- `settings.local.json` — Personal overrides layered on top of settings.json

## How Settings Work

### settings.json (shared)
Team-wide defaults. All agents inherit from this unless they override a specific item.

```json
{
  "defaults": {
    "claudeMd": "# Instructions for all agents...",
    "permissions": { "allow": ["Bash(git:*)", "Bash(npm:*)"] }
  },
  "quickOverrides": {
    "claudeMd": "# Quick agent specific instructions..."
  }
}
```

### settings.local.json (personal)
Your personal overrides. Merged on top of settings.json. Not committed.

### Per-agent overrides
Each agent can override specific config items (CLAUDE.md, permissions, MCP).
When an override is enabled, the agent manages that item locally instead of inheriting from defaults.

## Template Variables

CLAUDE.md templates support these variables:
- `{{AGENT_NAME}}` — The agent's name
- `{{AGENT_TYPE}}` — `durable` or `quick`
- `{{WORKTREE_PATH}}` — Absolute path to the agent's worktree
- `{{BRANCH}}` — The agent's standby branch
- `{{PROJECT_PATH}}` — Absolute path to the project root

## Agent Lifecycle

1. **Create** — A worktree + branch are created, config is materialized from defaults
2. **Materialize** — CLAUDE.md, permissions, MCP config, skills are written to the worktree
3. **Wake** — Missing config is repaired, hooks are set up, Claude Code is launched
4. **Work** — The agent works in its worktree on a feature branch
5. **Sleep** — Claude Code exits, the agent returns to sleeping state
