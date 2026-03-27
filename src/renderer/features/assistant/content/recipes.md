# Workflow Recipes

Use these patterns when a user's description matches the scenario. Each recipe
includes the exact tool sequence to follow.

## First project onboarding

When a user is new and wants to get started:

1. Use `find_git_repos` on common paths (`~/code`, `~/projects`, `~/src`, `~/dev`, `~/Documents`) to locate their repos
2. Present the list and ask which one(s) to add
3. Use `add_project` for each selected directory
4. Use `create_agent` with sensible defaults (worktree enabled, default model)
5. Explain: "Your agent has its own git branch. Click it in the sidebar to open a terminal and start chatting."

## Multi-service debugging (detailed)

When a user has multiple services and struggles with cross-service issues:

1. Use `list_projects` to check what's already added
2. For any missing services, use `find_git_repos` then `add_project`
3. Use `create_agent` for each service project (with descriptive names like "client-debugger", "api-debugger")
4. Use `write_agent_instructions` for each agent with focused instructions:
   - Client agent: "You focus on the React/Next.js frontend. When investigating API issues, describe the request shape and expected response so the server agent can investigate on its side."
   - Server agent: "You focus on the Go/Node API. When a request issue is reported, check the handler, middleware, and response format."
5. Use `create_canvas` with a descriptive name like "API Debugging"
6. Use `add_card` to add agent cards side by side (e.g., positions 100,200 and 500,200)
7. Use `add_card` to add a group project card in the center (position 300,200)
8. Use `connect_cards` to wire each agent to the group project
9. Use `add_card` type "zone" and `resize_card` to wrap everything, then `rename_card` to label it
10. Explain the bulletin board: "Post to the 'blockers' topic when you find an API mismatch, and the other agent will see it."

## Monorepo setup

When a user has a monorepo with multiple packages/services:

1. Use `add_project` with the monorepo root path
2. Use `create_agent` for each area — name them by responsibility:
   - "frontend" (or "web", "ui")
   - "backend" (or "api", "server")
   - "shared" (or "libs", "common")
3. Use `write_agent_instructions` for each with scoped focus:
   - Frontend agent: "Focus on src/frontend/. You handle React components, styling, and client-side state."
   - Backend agent: "Focus on src/api/. You handle routes, middleware, database queries, and API contracts."
   - Shared agent: "Focus on src/shared/. You maintain types, utilities, and validation logic used by both frontend and backend."
4. Use `create_canvas` and `add_card` for each agent
5. Use `layout_canvas` with "horizontal" pattern to arrange them
6. Optionally add a group project card for coordination

## Canvas-based team coordination

When a user wants to coordinate multiple agents on a shared goal:

1. Use `create_canvas`
2. Use `add_card` for each agent involved
3. Use `add_card` type "plugin" for a group project card (the coordination hub)
4. Use `connect_cards` to wire all agents to the group project
5. Use `layout_canvas` with "hub_spoke" pattern (group project as center)
6. Explain the bulletin board topics:
   - **progress**: Share status updates ("finished auth module, moving to tests")
   - **questions**: Ask questions for other agents ("what's the API contract for /users?")
   - **decisions**: Record architectural decisions ("using JWT for auth, not sessions")
   - **blockers**: Flag things that need another agent's help

## Agent instruction writing guide

When a user needs help writing effective CLAUDE.md instructions:

1. Ask what the agent's primary responsibility is
2. Ask about the project structure (what directories matter)
3. Draft focused instructions with these sections:
   - **Role**: One sentence describing the agent's purpose
   - **Focus areas**: Which directories/files this agent owns
   - **Conventions**: Code style, testing expectations, commit message format
   - **Boundaries**: What this agent should NOT touch
4. Use `write_agent_instructions` to save the instructions
5. Remind the user they can edit the file directly at any time

Example template:
```
# [Agent Name]

You are responsible for [specific area]. Focus on [directories].

## Conventions
- [Testing: write tests for all new functions]
- [Style: follow existing patterns in the codebase]
- [Commits: use conventional commit format]

## Boundaries
- Do not modify files outside [your scope]
- Do not change [shared configs] without checking with [other agent]
```

## Single to multi-agent migration

When a user has been using one agent and wants to scale up:

1. Use `list_agents` to see the current setup
2. Discuss how to split responsibilities (by feature area, by layer, by service)
3. Use `create_agent` for each new specialized agent
4. Use `write_agent_instructions` to give each agent focused scope
5. Consider creating a canvas to visualize and coordinate them
6. Explain: "Each agent gets its own git worktree, so they can work in parallel without conflicts."

## Quick agent workflows

When a user asks about quick vs durable agents:

- **Durable agents** persist across sessions, have their own worktree, and maintain history. Use for ongoing work.
- **Quick agents** are ephemeral — they run a single task and clean up. Use for one-off questions, code reviews, or small fixes.
- Quick agents can be spawned from durable agents, inheriting their defaults.
- Suggest durable agents for project work, quick agents for ad-hoc tasks.

## Plugin discovery

When a user wants to explore plugins:

1. Use `list_plugins` to show what's currently installed
2. Explain key built-in plugins: Canvas (visual workflows), Hub (workspace management)
3. Guide them to Settings > Plugins for enabling/disabling
4. Explain plugin scopes: "app" plugins are always available, "project" plugins are per-project
