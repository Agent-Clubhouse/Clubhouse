# Durable Agents

Durable agents are persistent, long-lived agents designed for ongoing work. They survive app restarts, maintain their own Git worktree, and can be paused and resumed across sessions.

## Creating a Durable Agent

1. Select a project, open the Agents tab, click **New Agent**
2. Configure: **Name**, **Color**, **Emoji**, **Branch**, **Model**, **Orchestrator**
3. Click **Create** — the agent appears in the explorer immediately
4. Give it a mission to start working, or leave it sleeping

> **Tip:** Use templates to pre-fill configuration for recurring agent types.

## Git Worktree Isolation

Each durable agent operates in its own worktree on a dedicated branch:
- Agent file operations are scoped to its worktree — your main checkout is unaffected
- Multiple agents can work on different branches simultaneously
- Merge agent work via standard Git (merge, PR, cherry-pick)

## Configuration

| Feature | Description |
|---------|-------------|
| **Instructions** | Markdown files in `.clubhouse/` guiding agent behavior — coding style, restrictions, workflow rules |
| **MCP** | Per-agent Model Context Protocol config — tool servers, resources, environment variables |
| **Skills** | Reusable prompt + tool packages (e.g., "commit", "review-pr", "test") defined at the project level |
| **Templates** | Save an agent's full config as a reusable starting point for new agents |

## Quick Agent Defaults

A durable agent can serve as a launchpad for quick agents, inheriting:
- System prompt (prepended to the quick agent's mission)
- Allowed tools (e.g., restrict to read-only access)
- Default model

Configure under the durable agent's **Quick Agent Defaults** section.

## Deleting

Delete from the context menu or config panel. Cleanup options:

| Option | What Happens |
|--------|-------------|
| **Commit and push** | Saves uncommitted work, pushes to remote, removes agent |
| **Cleanup branch** | Deletes local and remote branch |
| **Save as patch** | Exports changes as a `.patch` file (safest choice) |
| **Force delete** | Removes everything immediately — irreversible |
| **Just unregister** | Removes from Clubhouse, leaves branch and files on disk |
