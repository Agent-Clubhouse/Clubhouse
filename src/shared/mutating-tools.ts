/**
 * Authoritative definitions for tool/command sets that gate side-effects.
 *
 * Three distinct categories:
 *
 * 1. MUTATING_TOOLS — MCP tools that modify state and require user approval
 *    before execution in the assistant chat UI.
 *
 * 2. CREATION_TOOLS — Subset of MUTATING_TOOLS used for UI presentation
 *    (e.g., showing a creation icon/label on action cards).
 *
 * 3. MUTATING_CANVAS_COMMANDS — Canvas command-handler operations that
 *    trigger auto-save after execution. These are canvas-specific and do NOT
 *    overlap with MUTATING_TOOLS (different namespace).
 */

/** MCP tools that modify state — require user approval in the assistant UI. */
export const MUTATING_TOOLS = new Set([
  'create_project', 'create_canvas', 'create_agent',
  'add_card', 'add_zone', 'add_wire', 'update_card',
  'delete_project', 'delete_canvas', 'delete_agent',
  'write_file', 'run_command',
  'update_project', 'update_agent', 'update_canvas',
]);

/** Subset of MUTATING_TOOLS: creation/modification tools shown with special UI treatment. */
export const CREATION_TOOLS = new Set([
  'create_project', 'create_canvas', 'create_agent',
  'add_card', 'add_zone', 'add_wire', 'update_card',
]);

/** Canvas commands that trigger auto-save after execution. */
export const MUTATING_CANVAS_COMMANDS = new Set([
  'add_canvas', 'add_view', 'move_view', 'resize_view',
  'remove_view', 'rename_view', 'connect_views', 'disconnect_views',
  'import_blueprint', 'create_from_blueprint',
]);
