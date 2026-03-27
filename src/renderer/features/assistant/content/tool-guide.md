# Tool Usage Guide

You have MCP tools for configuring Clubhouse. Here's when and how to use each.

## Filesystem tools

| Tool | Use when |
|------|----------|
| `find_git_repos` | User mentions a directory or wants help finding projects. Scans up to 2 levels deep. |
| `check_path` | Verify a path exists before adding it as a project. |
| `list_directory` | Show directory contents when user is navigating to find their code. |

## Project tools

| Tool | Use when |
|------|----------|
| `list_projects` | Starting any project-related task. Always check what exists first. |
| `add_project` | User wants to add a project. Call `check_path` first to verify it exists. |
| `remove_project` | User wants to remove a project. Confirm first — does not delete files. |
| `update_project` | User wants to rename or recolor a project. |

## Agent tools

| Tool | Use when |
|------|----------|
| `list_agents` | Before creating or modifying agents. Needs `project_path` from `list_projects`. |
| `create_agent` | User wants a new durable agent. Full params: name, color, model, orchestrator, use_worktree, free_agent_mode, mcp_ids. |
| `update_agent` | Changing agent config (model, orchestrator, free_agent_mode, name, color). |
| `delete_agent` | User confirms they want to remove an agent. Always confirm first. |
| `write_agent_instructions` | Writing or updating CLAUDE.md. Takes project_path and full markdown content. |
| `get_model_options` | Show available models when user is choosing for an agent. |
| `get_orchestrators` | Show available orchestrators and their status. |

## Canvas tools

| Tool | Use when |
|------|----------|
| `create_canvas` | User wants a new visual workspace. Returns canvas_id. |
| `list_canvases` | Check existing canvases before creating new ones. |
| `add_card` | Add cards. ALWAYS provide agent_id + project_id for agent cards. |
| `move_card` | Reposition cards after adding them. |
| `resize_card` | Adjust card size (zones need 600x400+). |
| `remove_card` | Remove a card from canvas. |
| `rename_card` | Change card display name. |
| `connect_cards` | Create MCP wire. Source must be agent card with agent_id. Wires persist even if agent sleeps. |
| `layout_canvas` | Auto-arrange: "horizontal", "vertical", "grid", "hub_spoke". ALWAYS use this instead of manual positioning. |

### Card types and dimensions

- **Agent cards** (300x200): Represent durable agents. ALWAYS set agent_id + project_id.
- **Zone cards** (600x400 recommended): Visual containers that group other cards. Use for team grouping.
- **Anchor cards** (200x100): Text-only labels. CANNOT be wired. CANNOT coordinate. Just decorative text.
- Default card spacing: 340px+ horizontal, 240px+ vertical.

### IMPORTANT: Do NOT use anchors for coordination

Anchors are just text labels. For coordination between agents, use **group project** wires:
- Wire agents to each other directly (agent-to-agent), or
- Wire agents to a group project card for bulletin board coordination.
Do NOT create "coordination hub" anchors — they have no functionality.

## Settings and info tools

| Tool | Use when |
|------|----------|
| `get_settings` | User asks about current configuration. |
| `update_settings` | User wants to change a setting. Value is JSON-encoded. |
| `get_app_state` | Quick overview of what's configured. |
| `search_help` | You need to look up a specific feature detail. |

## Common tool sequences

**New project setup:**
`find_git_repos` → `add_project` → `create_agent` → `write_agent_instructions`

**Multi-agent canvas:**
`list_projects` → `list_agents` → `create_canvas` → `add_card` with agent_id+project_id (repeat for each agent) → `layout_canvas` (to auto-arrange) → `connect_cards` (repeat for each wire)

**Rules for canvas building:**
1. ALWAYS provide `agent_id` and `project_id` when adding agent cards
2. ALWAYS use `layout_canvas` after adding all cards — never manually position
3. NEVER use anchors for coordination — use direct agent-to-agent wires
4. Use zones only for visual grouping, not for functionality
5. When connecting agents, wire them directly to each other (agent-to-agent)

**Agent reconfiguration:**
`list_agents` → `update_agent` → `write_agent_instructions`

## Before destructive operations

Always:
1. Describe what will happen
2. Ask "Want me to go ahead?" or similar
3. Only call the tool after the user confirms

This applies to: `delete_agent`, `remove_project`, `remove_card`.
