# Durable Agents

Durable agents are long-lived, persistent agents designed for ongoing work. Unlike quick agents, they survive app restarts, maintain their own configuration, and can be paused and resumed across multiple sessions. A durable agent is the right choice when you need an AI assistant that stays with a task over time — building a feature branch, performing iterative refactors, or acting as a dedicated reviewer.

## Creating a Durable Agent

To create a durable agent:

1. Select a project in the Project Rail (left sidebar).
2. Click **New Agent** in the project's explorer panel.
3. Fill in the configuration form:
   - **Name** — a descriptive name for the agent (e.g., "feature-auth", "refactor-api").
   - **Color** — choose from 10+ colors used for the agent's avatar ring and accent highlights.
   - **Emoji / Avatar** — optionally pick an emoji to serve as the agent's visual avatar. If omitted, the agent uses the first letter of its name.
   - **Branch** — the Git branch the agent will work on. You can select an existing branch or create a new one.
   - **Model** — the AI model the agent will use, selected from the models available through the project's orchestrator.
   - **Orchestrator** — the backend that powers the agent (e.g., Claude Code). This is typically inherited from the project configuration.
4. Click **Create** to register the agent. It appears in the explorer list immediately.
5. Give the agent an initial mission to start it working, or leave it sleeping to configure further before launching.

## Customization

You can update a durable agent's appearance at any time from its configuration panel.

- **Name** — rename the agent to reflect its current purpose.
- **Color** — pick a new color from the palette. The color appears on the avatar ring, the explorer entry, and the terminal tab.
- **Emoji / Avatar** — change or remove the emoji avatar.

These changes take effect immediately and do not interrupt a running agent.

## Git Worktree

Each durable agent can operate in its own Git worktree, giving it an isolated copy of the repository on a dedicated branch. This means the agent can make commits, create files, and run builds without affecting your main working tree or other agents.

When you assign a branch to a durable agent, Clubhouse can automatically create a Git worktree for that branch. The worktree lives alongside your main repository checkout and is managed by Clubhouse. Benefits of worktree isolation include:

- **No conflicts** — the agent's changes do not appear in your editor or interfere with other agents.
- **Independent builds** — you can build and test the agent's branch without switching your own branch.
- **Clean diffs** — each agent's work is scoped to its own branch, making pull requests straightforward.

If you prefer not to use a worktree, the agent can work directly on the project's current branch, though this may lead to conflicts if multiple agents or manual edits are happening simultaneously.

## Agent Instructions

You can provide custom instructions that guide an agent's behavior. These instructions are stored in the `.clubhouse/` directory within the project and are loaded automatically when the agent starts.

Agent instructions are written in Markdown and can include:

- Coding style guidelines and conventions the agent should follow
- Repository structure notes to help the agent navigate the codebase
- Workflow rules such as "always write tests before implementation" or "commit frequently"
- Restrictions such as "do not modify files outside of the `src/` directory"

Instructions are per-agent, so different agents on the same project can have different behavioral guidelines.

## MCP Configuration

Each durable agent can have its own Model Context Protocol (MCP) configuration. MCP defines the set of tool servers and resources available to the agent during its session. You can configure MCP from the agent's settings panel to:

- Add or remove MCP tool servers (e.g., file system, web search, database access)
- Set server-specific parameters and environment variables
- Control which tools the agent is allowed to invoke

MCP configuration is stored per agent and does not affect other agents on the same project.

## Skills

Skills are reusable definitions that extend what an agent can do. A skill packages a prompt, a set of allowed tools, and optional configuration into a named unit that the agent can invoke during its session.

You can attach skills to a durable agent from its configuration panel. Skills might include things like:

- A "commit" skill that stages, commits, and pushes changes following your team's conventions
- A "review-pr" skill that fetches a pull request and provides structured feedback
- A "test" skill that runs the project's test suite and summarizes failures

Skills are defined at the project level and can be shared across multiple agents.

## Agent Templates

Agent templates let you save a durable agent's configuration as a reusable starting point for new agents. A template captures:

- Name pattern, color, and avatar
- Branch naming convention
- Model and orchestrator selection
- Agent instructions
- MCP configuration
- Attached skills

When creating a new durable agent, you can select a template to pre-fill the configuration form. This is useful for teams that want a consistent setup across agents or for quickly spinning up agents for recurring task types.

## Quick Agent Defaults

A durable agent can also serve as a launchpad for quick agents. From the durable agent's configuration, you can set defaults that apply to any quick agent spawned from it:

- **System prompt** — a base prompt prepended to the quick agent's mission.
- **Allowed tools** — restrict which tools the quick agent can use (e.g., read-only file access, no shell commands).
- **Default model** — the model the quick agent will use, which may differ from the durable agent's own model.

These defaults make it easy to run quick one-off tasks in the context of a durable agent's work without reconfiguring each time.

## Deleting a Durable Agent

When you no longer need a durable agent, you can delete it from the explorer's context menu or the agent's configuration panel. Clubhouse offers multiple cleanup options to ensure no work is lost:

| Option | What It Does |
|--------|-------------|
| **Commit and push changes** | Commits any uncommitted work on the agent's branch and pushes to the remote, then removes the agent and its worktree. |
| **Cleanup branch** | Deletes the agent's local and remote branch in addition to removing the agent registration. Use this when the branch has already been merged or is no longer needed. |
| **Save as patch** | Exports the agent's uncommitted changes as a `.patch` file you can apply later, then removes the agent and worktree. |
| **Force delete** | Removes the agent, its worktree, and all local changes immediately without saving anything. This is irreversible. |
| **Just unregister** | Removes the agent from Clubhouse without touching the Git branch or worktree. The branch and files remain on disk for manual cleanup. |

Choose the option that matches your situation. If you are unsure, **Save as patch** is the safest choice — it preserves the agent's work while cleaning up the Clubhouse registration.
