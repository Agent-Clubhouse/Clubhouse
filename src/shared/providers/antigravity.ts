/**
 * Shared names for the Antigravity CLI provider (#3785). One place for the ids,
 * the flag and the documented paths, so main, renderer and tests agree.
 *
 * Paths come from the public docs read on ANTIGRAVITY_DOCS_READ_DATE:
 * https://antigravity.google/docs/rules/, /skills/, /mcp/, /hooks/, /settings/.
 * Clubhouse never writes anything under the home folder's `.gemini`; the
 * global paths are read-only, for display and the bridge-name collision check.
 */

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-cli';

/** Preview-only experimental flag; the provider is hidden while it is off. */
export const ANTIGRAVITY_EXPERIMENTAL_FLAG = 'antigravityProvider';

/** The ACP chat driver id (`c.chat.driver`). Not registered until its gates close. */
export const ANTIGRAVITY_CHAT_DRIVER_ID = 'antigravity_acp';

/** When the public docs these paths and limits come from were read. */
export const ANTIGRAVITY_DOCS_READ_DATE = '2026-11-23';

/** Workspace files, relative to the agent's worktree. */
export const ANTIGRAVITY_PATHS = {
  configDir: '.agents',
  instructions: 'AGENTS.md',
  skillsRoot: '.agents/skills',
  mcpConfig: '.agents/mcp_config.json',
  hooks: '.agents/hooks.json',
} as const;

/**
 * The person's own Antigravity files, relative to the home folder. Read-only.
 * Only `cliSettings` (allowlisted non-secret fields) and `globalMcp` (server
 * names) are ever parsed; the rest are listed, never read.
 */
export const ANTIGRAVITY_GLOBAL_PATHS = {
  cliSettings: '.gemini/antigravity-cli/settings.json',
  globalMcp: '.gemini/config/mcp_config.json',
  globalHooks: '.gemini/config/hooks.json',
  rules: [
    '.gemini/AGENTS.md',
    '.gemini/GEMINI.md',
    '.gemini/config/AGENTS.md',
    '.gemini/config/GEMINI.md',
    '.gemini/config/rules',
  ],
  skills: ['.gemini/config/skills', '.gemini/antigravity-cli/skills', '.gemini/skills'],
} as const;

/** The reserved MCP server name for the Clubhouse bridge. */
export const ANTIGRAVITY_BRIDGE_SERVER_NAME = 'clubhouse';

/** The documented per-file rules limit; a larger composed AGENTS.md is refused, never truncated. */
export const ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES = 24_000;

/** The named hook Clubhouse merges into `.agents/hooks.json`. */
export const ANTIGRAVITY_STATUS_HOOK_NAME = 'clubhouse-status';
