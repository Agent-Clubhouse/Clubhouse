/**
 * Assistant API Surface Contract
 *
 * Typed interfaces for every assistant MCP tool handler. This is the single
 * source of truth for what the assistant can do and what each tool expects.
 *
 * Each tool contract includes:
 *   - Input types (with parameter aliases noted)
 *   - Output types (success + error shapes)
 *   - Side effects (what state changes)
 *   - Preconditions (what must exist first)
 */

// ── Shared types ──────────────────────────────────────────────────────────

/** Standard MCP tool result returned by all handlers. */
export interface ToolResult {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** Convenience type for a text-only result. */
export type TextResult = ToolResult & { content: [{ type: 'text'; text: string }] };

// ── Filesystem Tools ──────────────────────────────────────────────────────

export interface FindGitReposInput {
  /** Directory to scan (supports ~ expansion). */
  directory: string;
  /** Max search depth. Defaults to 2, capped at 2. */
  depth?: number;
}
/** Output: plain text listing repo paths, or "No git repositories found" message. */

export interface CheckPathInput {
  /** Path to check (supports ~ expansion). */
  path: string;
}
export interface CheckPathOutput {
  exists: boolean;
  type: 'file' | 'directory' | 'unknown';
  size?: number;
}

export interface ListDirectoryInput {
  /** Directory path to list (supports ~ expansion). */
  path: string;
}
export interface ListDirectoryEntry {
  name: string;
  type: 'file' | 'directory';
}
/** Output: JSON array of ListDirectoryEntry, max 100 items. Hidden files excluded. */

// ── App State Tools (read-only) ───────────────────────────────────────────

/** list_projects: no input required. */
export interface ListProjectsOutput {
  id: string;
  name: string;
  path: string;
}

export interface ListAgentsInput {
  /** Project directory path. */
  project_path: string;
}
export interface ListAgentsOutput {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  model: string;
  hasWorktree: boolean;
  orchestrator: string;
}

/** get_app_state: no input required. */
export interface GetAppStateOutput {
  projectCount: number;
  projects: Array<{ id: string; name: string }>;
  orchestrators: Array<{ id: string; displayName: string }>;
}

/** get_orchestrators: no input required. */
export interface GetOrchestratorsOutput {
  id: string;
  displayName: string;
  available: boolean;
  error?: string;
}

// ── Help & Settings Tools ─────────────────────────────────────────────────

export interface SearchHelpInput {
  /** Search query (e.g. "canvas", "durable agents"). */
  query: string;
}
/** Output: formatted markdown with top 3 results (full content for best match, snippets for rest). */

/** get_settings: no input. Output: raw JSON from settings.json. */

/** list_themes: no input. */
export interface ListThemesOutput {
  currentTheme: string;
  availableThemes: Array<{ id: string; name: string; type: string }>;
}

// ── Project Write Tools ───────────────────────────────────────────────────

export interface AddProjectInput {
  /** Absolute path to directory (supports ~ expansion). */
  path: string;
}
/**
 * Precondition: path must exist and be a directory.
 * Side effect: adds project to project store.
 */

export interface RemoveProjectInput {
  /** Project ID (from list_projects). */
  project_id: string;
}
/**
 * Precondition: project must exist.
 * Side effect: removes project from store. Does NOT delete files on disk.
 */

export interface UpdateProjectInput {
  /** Project ID. */
  project_id: string;
  /** New display name. */
  display_name?: string;
  /** New color. */
  color?: string;
}

// ── Agent Write Tools ─────────────────────────────────────────────────────

export interface CreateAgentInput {
  /** Project directory path. Required. */
  project_path: string;
  /** Agent name. Auto-generated if omitted. */
  name?: string;
  /** Color ID (e.g. "emerald", "indigo"). */
  color?: string;
  /** Model identifier (e.g. "claude-opus"). */
  model?: string;
  /** Orchestrator ID (e.g. "claude-code", "copilot-cli"). */
  orchestrator?: string;
  /** Create isolated git worktree. Defaults to true. */
  use_worktree?: boolean;
  /** Enable free agent mode. */
  free_agent_mode?: boolean;
  /** Comma-separated MCP server IDs. */
  mcp_ids?: string;
  /** Persona template ID for auto-injecting instructions. */
  persona?: string;
}
export interface CreateAgentOutput {
  message: string;
  id: string;
  name: string;
  color: string;
  icon: string | null;
  hasWorktree: boolean;
  worktreePath?: string;
  model: string;
  orchestrator: string;
  persona: string | null;
}
/**
 * Side effects:
 *   - Creates durable agent config via agent-config.createDurable()
 *   - If persona specified: reads persona template, resolves orchestrator,
 *     appends persona instructions to existing CLAUDE.md
 */

export interface UpdateAgentInput {
  /** Project directory path. Required. */
  project_path: string;
  /** Agent ID. Required. */
  agent_id: string;
  name?: string;
  color?: string;
  /** Set to "" to remove custom icon. Omit to leave unchanged. */
  icon?: string;
  model?: string;
  orchestrator?: string;
  free_agent_mode?: boolean;
  clubhouse_mode_override?: boolean;
}

export interface DeleteAgentInput {
  /** Project directory path. Required. */
  project_path: string;
  /** Agent ID. Required. */
  agent_id: string;
}
/**
 * Side effect: removes agent config and worktree. Cannot be undone.
 */

export interface WriteAgentInstructionsInput {
  /** Project directory or agent worktree path. Required. */
  project_path: string;
  /** Full markdown content to write. Required. */
  content: string;
  /** Orchestrator ID to determine file path. */
  orchestrator?: string;
}
/**
 * Side effect: writes instructions file via orchestrator provider.
 */

// ── Settings Write Tool ───────────────────────────────────────────────────

export interface UpdateSettingsInput {
  /** Settings key (e.g. "theme", "soundEnabled"). */
  key: string;
  /** Value as JSON string (parsed for bools/numbers). */
  value: string;
}
/**
 * Side effects:
 *   - For theme/themeId: calls themeService.saveSettings() + IPC THEME_CHANGED
 *   - For other keys: reads settings.json, merges, writes back
 */

// ── Canvas Tools ──────────────────────────────────────────────────────────

export interface CreateCanvasInput {
  /** Canvas name. Auto-generated if omitted. */
  name?: string;
  /** Project ID for project-level canvas. Omit for app-level. */
  project_id?: string;
}
/**
 * Side effect: creates canvas in renderer store via IPC.
 * Output: { canvas_id, name }
 */

export interface ListCanvasesInput {
  /** Project ID to filter. Omit for app-level. */
  project_id?: string;
}

export interface AddCardInput {
  /** Canvas ID. Required. */
  canvas_id: string;
  /** Card type: "agent", "zone", or "anchor". Required. */
  type: 'agent' | 'zone' | 'anchor';
  /** Display name for the card. */
  display_name?: string;
  /** For agent cards: the durable agent ID. */
  agent_id?: string;
  /** For agent cards: the project ID the agent belongs to. */
  project_id?: string;
  /** X position (auto-staggered if omitted). */
  position_x?: number;
  /** Y position (auto-staggered if omitted). */
  position_y?: number;
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Zone view ID to place this card inside. */
  zone_id?: string;
}
/**
 * Side effects:
 *   - Adds view to canvas store via IPC (with retry on "Canvas not found")
 *   - Auto-staggers position: 340px H offset, wraps after 4 columns
 *   - If zone_id: queries existing views and positions within zone bounds
 * Precondition: canvas_id must exist (retries 3x with backoff if not found yet).
 */

export interface MoveCardInput {
  /** Canvas ID. Required. */
  canvas_id: string;
  /** Card view ID. Required. */
  view_id: string;
  /** X position. */
  x?: number;
  /** Y position. */
  y?: number;
  /** Alias for x. */
  position_x?: number;
  /** Alias for y. */
  position_y?: number;
  /** Zone view ID to auto-position within. */
  zone_id?: string;
}
/**
 * Either (x, y), (position_x, position_y), or zone_id required.
 * Aliases: position_x → x, position_y → y.
 */

export interface ResizeCardInput {
  canvas_id: string;
  view_id: string;
  width: number;
  height: number;
}

export interface RemoveCardInput {
  canvas_id: string;
  view_id: string;
}

export interface RenameCardInput {
  canvas_id: string;
  view_id: string;
  name: string;
}

export interface ConnectCardsInput {
  /** Canvas ID. Required. */
  canvas_id: string;
  /** Source card view ID (must be agent card). */
  source_view_id?: string;
  /** Target card view ID. */
  target_view_id?: string;
  /** Alias for source_view_id. */
  from_card_id?: string;
  /** Alias for target_view_id. */
  to_card_id?: string;
  /** Bidirectional wiring. Default: true for agent-to-agent. */
  bidirectional?: boolean;
}
/**
 * Aliases: from_card_id → source_view_id, to_card_id → target_view_id.
 * At least source + target required (via either name).
 * Side effect: creates wire definition + MCP binding via IPC.
 */

export interface LayoutCanvasInput {
  /** Canvas ID. Required. */
  canvas_id: string;
  /** Layout pattern. Required. */
  pattern: 'horizontal' | 'vertical' | 'grid' | 'hub_spoke';
}
/**
 * Side effects:
 *   - Queries all views, computes layout, moves each card
 *   - Zone-aware: cards inside zones arranged within zone bounds
 *   - Resets auto-stagger counter for this canvas
 */

// ── Tool Catalog ──────────────────────────────────────────────────────────

/**
 * Complete catalog of assistant tool suffixes, organized by category.
 * Use for enumeration, validation, and test scaffolding.
 */
export const ASSISTANT_TOOL_CATALOG = {
  filesystem: ['find_git_repos', 'check_path', 'list_directory'] as const,
  appState: ['list_projects', 'list_agents', 'get_app_state', 'get_orchestrators'] as const,
  help: ['search_help'] as const,
  settings: ['get_settings', 'list_themes', 'update_settings'] as const,
  projectWrite: ['add_project', 'remove_project', 'update_project'] as const,
  agentWrite: ['create_agent', 'update_agent', 'delete_agent', 'write_agent_instructions'] as const,
  canvas: [
    'create_canvas', 'list_canvases', 'add_card', 'move_card',
    'resize_card', 'remove_card', 'rename_card', 'connect_cards', 'layout_canvas',
    'get_card_defaults',
  ] as const,
} as const;

/** Flat list of all tool suffixes. */
export const ALL_TOOL_SUFFIXES = Object.values(ASSISTANT_TOOL_CATALOG).flat();

/** Parameter alias map: common LLM guesses → actual parameter names. */
export const PARAMETER_ALIASES: Record<string, Record<string, string>> = {
  connect_cards: {
    from_card_id: 'source_view_id',
    to_card_id: 'target_view_id',
  },
  move_card: {
    position_x: 'x',
    position_y: 'y',
  },
};
