/**
 * Per-driver capability record. Each chat driver publishes one in its
 * `session_started` event; the UI reads it to downgrade gracefully instead of
 * checking provider ids (e.g. Copilot over ACP v1 can't steer, so the composer
 * offers "Stop and send"). Values describe what the driver can do live, in an
 * active session, on the installed CLI version. A flag is only added together
 * with the runtime method that uses it (fork and rewind come later; Clubhouse
 * checkpoints cover revert meanwhile).
 */

/** Concrete chat transports. Also the `c.chat.driver` telemetry values. */
export type ChatDriverId =
  | 'claude_agent_sdk'
  | 'claude_stream_json'
  | 'codex_app_server'
  | 'copilot_acp'
  | 'copilot_sdk'
  /** Any other ACP agent (Gemini CLI, etc.) through the generic ACP driver. */
  | 'acp';

/**
 * Clubhouse's five-level permission ladder. Each driver maps these to its
 * native modes (shown to the user under each level).
 */
export type PermissionLevel = 'plan' | 'ask' | 'auto_edit' | 'auto' | 'full_access';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['plan', 'ask', 'auto_edit', 'auto', 'full_access'];

export interface ChatCapabilities {
  /** Send a message into the running turn. */
  steer: boolean;
  /** Queue messages for the next turn: natively, client-side by Clubhouse, or not at all. */
  queue: 'native' | 'client' | 'none';
  /** Cancel the running turn without ending the session. */
  interrupt: boolean;
  /** Continue a native session after the process restarts. 'replay' means history is re-streamed on load. */
  resume: 'native' | 'replay' | 'none';
  /** Structured approval of a proposed plan. */
  planApproval: boolean;
  /** The agent can ask the user a structured question mid-turn. */
  questions: boolean;
  subagents: 'full' | 'ids_only' | 'none';
  /** What usage data arrives: dollars, tokens, only context fill, or nothing. */
  usage: 'cost' | 'tokens' | 'context' | 'none';
  /** Plan/rate-limit windows (Claude 5h/7d, Codex rate limits). */
  limits: boolean;
  images: boolean;
  slashCommands: boolean;
  modelSwitch: 'live' | 'per_turn' | 'restart' | 'none';
  /** Reasoning-effort changes: applied live, from the next turn, only on the next start, or not supported. */
  effortSwitch: 'live' | 'per_turn' | 'restart' | 'none';
  /** Levels the driver can switch to without restarting the session. */
  liveLevels: readonly PermissionLevel[];
  /** How the user logs in when auth is missing. */
  login: 'api' | 'terminal' | 'none';
  /**
   * The driver can pass a system prompt natively (CLI flag or protocol field).
   * When false, the runtime prepends it to the first user message instead.
   */
  systemPrompt: boolean;
  /**
   * Which `PermissionResponseExtras` the driver carries to the CLI with a
   * permission answer: a message with a denial (what to do instead), and an
   * edited tool input with an approval (e.g. a revised plan for Claude's
   * ExitPlanMode). Absent means neither; a driver that doesn't carry an extra
   * ignores it, so the UI only offers what's reported here.
   */
  permissionExtras?: { denyMessage: boolean; updatedInput: boolean };
}

/** Conservative baseline: a driver starts from this and turns on what it supports. */
export const MINIMAL_CHAT_CAPABILITIES: ChatCapabilities = Object.freeze({
  steer: false,
  queue: 'client',
  interrupt: false,
  resume: 'none',
  planApproval: false,
  questions: false,
  subagents: 'none',
  usage: 'none',
  limits: false,
  images: false,
  slashCommands: false,
  modelSwitch: 'none',
  effortSwitch: 'none',
  liveLevels: [],
  login: 'terminal',
  systemPrompt: false,
}) as ChatCapabilities;
