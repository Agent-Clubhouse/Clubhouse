# Workflow Recipes

Use these patterns when a user's description matches the scenario. Each recipe
includes the exact tool sequence to follow.

**After every creation action** (project, agent, canvas), always offer to help
the user navigate to what you created. Projects appear in the sidebar, agents
in the agent panel, and canvases in the tab bar.

## First project onboarding

When a user is new and wants to get started:

1. Use `find_git_repos` on common paths (`~/code`, `~/projects`, `~/src`, `~/dev`, `~/Documents`) to locate their repos
2. Present the list and ask which one(s) to add
3. Use `add_project` for each selected directory
4. Use `create_agent` with sensible defaults (worktree enabled, default model)
5. Summarize and offer navigation: "Your project and agent are set up. The project is in the sidebar — click it to see your agent. Would you like me to create a canvas to visualize your workspace?"

## Canvas-based team coordination

When a user wants to coordinate multiple agents on a shared goal:

1. Use `create_canvas`
2. Use `add_card` for each agent involved (ALWAYS set agent_id + project_id)
3. Use `add_card` type "plugin" for a group project card (the coordination hub)
4. Use `connect_cards` to wire all agents to the group project
5. Use `layout_canvas` with "hub_spoke" pattern (group project as center)
6. Explain bulletin board topics: progress, questions, decisions, blockers
7. Offer navigation: "Your canvas is ready in the tab bar. Would you like me to take you there?"

## Agent instruction writing guide

When a user needs help writing effective CLAUDE.md instructions:

1. Ask what the agent's primary responsibility is
2. Ask about the project structure (what directories matter)
3. Draft focused instructions with: **Role** (one sentence), **Focus areas** (directories), **Conventions** (style, testing, commits), **Boundaries** (what NOT to touch)
4. Use `write_agent_instructions` to save the instructions

## Monorepo setup

When a user has a monorepo with multiple packages/services:

1. Use `add_project` with the monorepo root path
2. Use `create_agent` for each area — name them by responsibility (frontend, backend, shared)
3. Use `write_agent_instructions` for each with scoped focus on their directories
4. Create a canvas with `layout_canvas` "horizontal" to visualize the setup
5. Optionally add a group project card for coordination

## Quick vs durable agents

When a user asks about agent types:

- **Durable agents** persist across sessions, have their own worktree, and maintain history. Use for ongoing work.
- **Quick agents** are ephemeral — they run a single task and clean up. Use for one-off questions, code reviews, or small fixes.
- Suggest durable agents for project work, quick agents for ad-hoc tasks.

## Multi-agent debugging

When a user has multiple services and struggles with cross-service issues:

1. Ensure all service projects are added (`list_projects`, then `add_project` for missing ones)
2. Create a focused agent per service with descriptive names (e.g., "client-debugger", "api-debugger")
3. Write scoped instructions for each using `write_agent_instructions`
4. Create a canvas, wire agents to a group project for bulletin board coordination
5. Explain: "Post to the 'blockers' topic when you find an API mismatch, and the other agent will see it."
