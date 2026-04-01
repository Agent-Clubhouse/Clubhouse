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
| `list_agents` | Before creating or modifying agents. Needs `project_path` from `list_projects`. Returns icon info. |
| `create_agent` | User wants a new durable agent. Full params: name, color, model, orchestrator, use_worktree, free_agent_mode, mcp_ids. |
| `update_agent` | Changing agent config (model, orchestrator, free_agent_mode, name, color, icon). |
| `delete_agent` | User confirms they want to remove an agent. Always confirm first. |
| `write_agent_instructions` | Writing or updating CLAUDE.md. Takes project_path and full markdown content. |
| `get_model_options` | Show available models when user is choosing for an agent. |
| `get_orchestrators` | Show available orchestrators and their status. |

### IMPORTANT: Preserve custom agent icons

Agents may have custom icons set by the user (shown as a non-null `icon` field in `list_agents`).
- NEVER clear or overwrite an agent's icon unless the user explicitly asks to change it.
- When building canvases, only use `add_card` to reference agents — do NOT update or recreate them.
- If you need to update agent properties (name, color, model), omit the `icon` field to leave it unchanged.

## Canvas tools

| Tool | Use when |
|------|----------|
| `create_canvas_from_blueprint` | **Preferred for 3+ cards.** Atomic zones + cards + wires in one JSON call. |
| `create_canvas` | Single empty canvas. |
| `list_canvases` | Check existing canvases. |
| `add_card` | Add one card. Set agent_id + project_id for agents. |
| `move_card` | Reposition. Supports relative positioning and zones. |
| `connect_cards` | Create MCP wire between cards. |
| `disconnect_cards` | Remove a wire. |
| `layout_canvas` | Auto-arrange: horizontal, vertical, grid, hub_spoke, auto. |

### Card types and dimensions

| Card type | Default size | Use for |
|-----------|-------------|---------|
| **Agent** | 300x200 | Durable agents. ALWAYS set agent_id + project_id. |
| **Zone** | 600x400 | Visual containers that group other cards. |
| **Anchor** | 200x100 | Text-only labels. CANNOT be wired. See `list_card_types` for all. |

**Spacing:** 340px+ horizontal, 260px+ vertical between cards.

Cards are auto-staggered when you omit position — no need to calculate coordinates manually.

### Zone containment

Containment is **spatial** — a card is inside a zone when >50% overlaps the zone bounds. Use `zone_id` in `add_card`/`move_card` to auto-position within a zone. Zone title bar is 32px tall; minimum size 600x400. `layout_canvas` is zone-aware — contained cards stay grouped.

### Relative positioning

Use `relative_to_card_id` + `relative_position` ("right"/"left"/"below"/"above") in `add_card` or `move_card` to place cards next to existing ones. Optional `relative_buffer` sets the gap (default 60px). Priority: `relative_to_card_id` > `zone_id` > `position_x/y` > auto-stagger.

### Parameter names

Tool parameters use these exact names:
- `connect_cards`: `source_view_id`, `target_view_id` (also accepts `from_card_id`, `to_card_id`)
- `move_card`: `x`, `y` (also accepts `position_x`, `position_y`)
- `add_card`: `width`, `height` must be **numbers** (not strings)

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
| `search_help` | Look up detailed help content on any Clubhouse feature. Always use this before answering feature questions. |

### Settings keys reference

`update_settings` writes to the app's `settings.json` (key-value store). Known keys:

| Key | Type | Valid values | Description |
|-----|------|-------------|-------------|
| `theme` | string | `"catppuccin-mocha"`, `"catppuccin-latte"`, `"solarized-dark"`, `"terminal"`, `"nord"`, `"dracula"`, `"tokyo-night"`, `"gruvbox-dark"`, `"cyberpunk"`, or `"plugin:<id>"` for plugin themes | App color theme |
| `soundEnabled` | boolean | `true`, `false` | Enable/disable notification sounds |
| `clipboardCompat` | boolean | `true`, `false` | Clipboard compatibility mode |
| `editorCommand` | string | `"code"`, `"cursor"`, `"zed"`, etc. | External editor launch command |
| `editorName` | string | `"VS Code"`, `"Cursor"`, `"Zed"`, etc. | Display name for the external editor |

**Note:** `update_settings` accepts any key, but changing unrecognized keys has no effect on the UI. For domain-specific settings (notifications, logging, MCP, security, annex), guide users to Settings in the app instead — those use separate config files managed by the renderer.

## Common tool sequences

**New project setup:**
`find_git_repos` → `add_project` → `create_agent` → `write_agent_instructions`

**Multi-agent canvas:**
`list_projects` → `list_agents` → `create_canvas` → `add_card` with agent_id+project_id (repeat for each agent) → `layout_canvas` (to auto-arrange) → `connect_cards` (repeat for each wire)

**Rules for canvas building:**
1. ALWAYS provide `agent_id` and `project_id` when adding agent cards
2. ALWAYS call `layout_canvas` after adding ALL cards — this auto-arranges them properly
3. NEVER use anchors for coordination — use direct agent-to-agent wires
4. Use zones for visual grouping — add the zone first, then add cards with `zone_id` to place them inside
5. When connecting agents, wire them directly to each other (agent-to-agent)
6. NEVER modify existing agents (update_agent, delete_agent) when building a canvas — only reference them via add_card
7. For 3+ cards, use `create_canvas_from_blueprint` — one JSON call creates everything atomically.
8. Pass `width` and `height` as **numbers**, not strings (e.g., `300` not `"300"`)

**Agent reconfiguration:**
`list_agents` → `update_agent` → `write_agent_instructions`

**Plugin install:**
`list_marketplace_plugins` → `download_marketplace_plugin` → `open_plugin_settings`

## Marketplace tools

| Tool | Use when |
|------|----------|
| `list_marketplace_plugins` | User asks about plugins or has a need one could solve. Filterable. |
| `download_marketplace_plugin` | Install a plugin. Downloads only — user enables in Settings > Plugins. |
| `open_plugin_settings` | After downloading or to manage plugins. Opens plugin settings |

Suggest plugins when user needs match plugin capabilities

## Before destructive operations

Always:
1. Describe what will happen
2. Ask "Want me to go ahead?" or similar
3. Only call the tool after the user confirms

This applies to: `delete_agent`, `remove_project`, `remove_card`.
