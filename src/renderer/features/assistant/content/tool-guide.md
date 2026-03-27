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
| `create_canvas` | User wants a new visual workspace. Returns canvas_id for subsequent calls. |
| `list_canvases` | Check existing canvases before creating new ones. |
| `add_card` | Add agent/zone/anchor cards. Types: "agent", "zone", "anchor". |
| `move_card` | Reposition cards after adding them. |
| `resize_card` | Adjust card size (useful for zones). |
| `remove_card` | Remove a card from canvas. |
| `rename_card` | Change card display name. |
| `connect_cards` | Create MCP wire between two cards. Source must be an agent card. |
| `layout_canvas` | Auto-arrange: "horizontal", "vertical", "grid", "hub_spoke". |

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
`list_projects` → `create_canvas` → `add_card` (multiple) → `layout_canvas` → `connect_cards` (multiple)

**Agent reconfiguration:**
`list_agents` → `update_agent` → `write_agent_instructions`

## Before destructive operations

Always:
1. Describe what will happen
2. Ask "Want me to go ahead?" or similar
3. Only call the tool after the user confirms

This applies to: `delete_agent`, `remove_project`, `remove_card`.
