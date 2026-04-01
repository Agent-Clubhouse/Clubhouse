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
4. Use `create_agent` with sensible defaults. Use `persona` param if user describes a role
5. Summarize and offer navigation to the sidebar

## Canvas-based team coordination

When a user wants to coordinate multiple agents on a shared goal:

1. Match the user's description to a cookbook pattern (squad, bake-off, ui-work, etc.)
2. Use `create_canvas_from_blueprint` with the cookbook's blueprint JSON for atomic setup
3. If blueprint API unavailable, fall back to: `create_canvas` → `create_agent` (with `persona`) → `add_card` → `connect_cards` → `layout_canvas`
4. Explain bulletin board topics and offer navigation

## Agent instruction writing guide

When a user needs help writing effective CLAUDE.md instructions:

1. Ask what the agent's primary responsibility is
2. Ask about the project structure (what directories matter)
3. Draft focused instructions with: **Role** (one sentence), **Focus areas** (directories), **Conventions** (style, testing, commits), **Boundaries** (what NOT to touch)
4. Use `write_agent_instructions` to save the instructions

## Monorepo setup

When a user has a monorepo with multiple packages/services:

1. Use `add_project` with the monorepo root path
2. Use `create_agent` for each area with appropriate `persona` — name by responsibility
3. Use `write_agent_instructions` for each with scoped focus on their directories
4. Create a canvas with `layout_canvas` "horizontal" to visualize the setup
5. Optionally add a group project card for coordination

## Quick vs durable agents

When a user asks about agent types:

- **Durable agents** persist across sessions, have their own worktree, and maintain history. Use for ongoing work.
- **Quick agents** are ephemeral — they run a single task and clean up. Use for one-off questions, code reviews, or small fixes.
- Suggest durable agents for project work, quick agents for ad-hoc tasks.

## Plugin install

`list_marketplace_plugins` → `download_marketplace_plugin` → `open_plugin_settings`

## Multi-agent debugging

When a user has multiple services and struggles with cross-service issues:

1. Ensure all service projects are added (`list_projects`, then `add_project` for missing ones)
2. Create a focused agent per service with descriptive names (e.g., "client-debugger", "api-debugger")
3. Write scoped instructions for each using `write_agent_instructions`
4. Create a canvas, wire agents to a group project for bulletin board coordination
5. Explain: "Post to the 'blockers' topic when you find an API mismatch, and the other agent will see it."
