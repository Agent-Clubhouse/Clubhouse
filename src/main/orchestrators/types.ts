import type { StructuredEvent } from '../../shared/structured-events';
import type { StreamJsonEvent } from '../services/jsonl-parser';
import type { McpServerDef } from '../../shared/types';

export type OrchestratorId = 'claude-code' | (string & {});

export type AgentExecutionMode = 'pty' | 'headless' | 'structured';

export interface SpawnOpts {
  cwd: string;
  model?: string;
  mission?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  resume?: boolean;
  /** Specific session ID to resume; when resume is true but sessionId is absent, resume the most recent session */
  sessionId?: string;
  agentId?: string;
  freeAgentMode?: boolean;
}

export interface HeadlessOpts extends SpawnOpts {
  outputFormat?: string;
  permissionMode?: string;
  noSessionPersistence?: boolean;
  disallowedTools?: string[];
}

export type HeadlessOutputKind = 'stream-json' | 'text';

export interface SpawnCommandResult {
  binary: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HeadlessCommandResult {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  outputKind?: HeadlessOutputKind;  // defaults to 'stream-json'
}

export interface NormalizedHookEvent {
  kind: 'pre_tool' | 'post_tool' | 'tool_error' | 'stop' | 'notification' | 'permission_request';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  message?: string;
}

export interface OrchestratorConventions {
  /** Directory name under the project root for agent config (e.g. '.claude') */
  configDir: string;
  /** Filename for local instructions (e.g. 'CLAUDE.local.md') */
  localInstructionsFile: string;
  /** Legacy instructions filename (e.g. 'CLAUDE.md') */
  legacyInstructionsFile: string;
  /** MCP config filename (e.g. '.mcp.json') */
  mcpConfigFile: string;
  /** Subdirectory name for skills (e.g. 'skills') */
  skillsDir: string;
  /** Subdirectory name for agent templates (e.g. 'agents') */
  agentTemplatesDir: string;
  /** Settings filename within configDir (e.g. 'settings.local.json') */
  localSettingsFile: string;
  /** Format of the settings and MCP config files. Defaults to 'json'. */
  settingsFormat?: 'json' | 'toml';
}

export interface ProviderCapabilities {
  headless: boolean;
  structuredOutput: boolean;
  hooks: boolean;
  sessionResume: boolean;
  permissions: boolean;
  structuredMode: boolean;
  structuredProtocol?: 'acp';
}

/**
 * Timing configuration for the multi-line paste submit sequence.
 *
 * When sending a message to a PTY agent, bracketed paste is used for
 * multi-line content, followed by Enter keystrokes to accept and submit.
 * Different CLIs process paste events at different speeds, so the delays
 * between steps are configurable per provider.
 */
export interface PasteSubmitTiming {
  /** Delay (ms) before the first Enter keystroke after pasting content */
  initialDelayMs: number;
  /** Delay (ms) before checking the buffer / sending a retry Enter */
  retryDelayMs: number;
  /** Delay (ms) for the final buffer check after the last Enter */
  finalCheckDelayMs: number;
}

// ── Capability Sub-interfaces ───────────────────────────────────────────────
// Providers only implement interfaces for features they support.
// Use the type guard functions (isHookCapable, etc.) to narrow at call sites.

/** Providers that support hook configuration and event parsing */
export interface HookCapable {
  writeHooksConfig(cwd: string, hookUrl: string): Promise<void>;
  parseHookEvent(raw: unknown): NormalizedHookEvent | null;
}

/** Providers that support headless (non-interactive) execution */
export interface HeadlessCapable {
  buildHeadlessCommand(opts: HeadlessOpts): Promise<HeadlessCommandResult | null>;
}

/** Providers that support session listing, transcript reading, and ID extraction */
export interface SessionCapable {
  /** List available CLI sessions for the given project directory */
  listSessions(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>>;

  /** Read a historical session transcript from the CLI's own storage.
   *  Returns raw StreamJsonEvent[] or null if session not found. */
  readSessionTranscript(
    sessionId: string,
    cwd: string,
    profileEnv?: Record<string, string>,
  ): Promise<StreamJsonEvent[] | null>;

  /** Extract session ID from PTY buffer output, if recognizable */
  extractSessionId(ptyBuffer: string): string | null;
}

/** Providers that support structured mode via an adapter */
export interface StructuredCapable {
  createStructuredAdapter(): StructuredAdapter;
}

// ── Type Guards ─────────────────────────────────────────────────────────────

/** Check if a provider supports hooks (writeHooksConfig, parseHookEvent) */
export function isHookCapable(provider: OrchestratorProvider): provider is OrchestratorProvider & HookCapable {
  return provider.getCapabilities().hooks
    && typeof (provider as unknown as HookCapable).writeHooksConfig === 'function';
}

/** Check if a provider supports headless execution */
export function isHeadlessCapable(provider: OrchestratorProvider): provider is OrchestratorProvider & HeadlessCapable {
  return provider.getCapabilities().headless
    && typeof (provider as unknown as HeadlessCapable).buildHeadlessCommand === 'function';
}

/** Check if a provider supports session management */
export function isSessionCapable(provider: OrchestratorProvider): provider is OrchestratorProvider & SessionCapable {
  return provider.getCapabilities().sessionResume
    && typeof (provider as unknown as SessionCapable).listSessions === 'function';
}

/** Check if a provider supports structured mode */
export function isStructuredCapable(provider: OrchestratorProvider): provider is OrchestratorProvider & StructuredCapable {
  return provider.getCapabilities().structuredMode
    && typeof (provider as unknown as StructuredCapable).createStructuredAdapter === 'function';
}

// ── Core Interface ──────────────────────────────────────────────────────────

export interface OrchestratorProvider {
  readonly id: OrchestratorId;
  readonly displayName: string;
  readonly shortName: string;
  readonly badge?: string;

  // Capabilities
  getCapabilities(): ProviderCapabilities;

  // Lifecycle
  checkAvailability(envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string }>;
  buildSpawnCommand(opts: SpawnOpts): Promise<SpawnCommandResult>;
  getExitCommand(): string;

  // Instructions
  readInstructions(worktreePath: string): string;
  writeInstructions(worktreePath: string, content: string): void;

  // Conventions
  readonly conventions: OrchestratorConventions;

  // UI helpers
  getModelOptions(): Promise<Array<{ id: string; label: string }>>;
  getDefaultPermissions(kind: 'durable' | 'quick'): string[];
  toolVerb(toolName: string): string | undefined;

  /** Timing for the paste-then-submit sequence used by agent-to-agent messaging */
  getPasteSubmitTiming(): PasteSubmitTiming;

  // Profile support
  /** Return the env var keys this orchestrator uses for config isolation (e.g. CLAUDE_CONFIG_DIR) */
  getProfileEnvKeys(): string[];

  /**
   * Optional: return CLI args to inject MCP server config at spawn time.
   * Used by orchestrators that don't read MCP from a project-level config file
   * (e.g. Copilot CLI uses --additional-mcp-config instead of .github/mcp.json).
   * Receives a pre-built server definition to avoid transitive electron imports.
   */
  buildMcpArgs?(serverDef: McpServerDef): string[];
}

// ── Structured Mode ─────────────────────────────────────────────────────────

export interface StructuredSessionOpts {
  mission: string;
  systemPrompt?: string;
  model?: string;
  cwd: string;
  env?: Record<string, string>;
  sessionId?: string; // for resume
  allowedTools?: string[];
  disallowedTools?: string[];
  freeAgentMode?: boolean;
  /** Shell command prefix prepended before the CLI binary */
  commandPrefix?: string;
}

export interface StructuredAdapter {
  /** Start a structured session. Returns an async iterable of StructuredEvents. */
  start(opts: StructuredSessionOpts): AsyncIterable<StructuredEvent>;

  /** Send a follow-up user message mid-session */
  sendMessage(message: string): Promise<void>;

  /** Respond to a permission request */
  respondToPermission(requestId: string, approved: boolean, reason?: string): Promise<void>;

  /** Cancel the running session */
  cancel(): Promise<void>;

  /** Cleanup resources */
  dispose(): void;
}
