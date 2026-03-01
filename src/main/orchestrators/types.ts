import type { StructuredEvent } from '../../shared/structured-events';

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
  structuredProtocol?: 'sdk' | 'acp' | 'app-server';
}

export interface OrchestratorProvider {
  readonly id: OrchestratorId;
  readonly displayName: string;
  readonly shortName: string;
  readonly badge?: string;

  // Capabilities
  getCapabilities(): ProviderCapabilities;

  // Lifecycle
  checkAvailability(envOverride?: Record<string, string>): Promise<{ available: boolean; error?: string }>;
  buildSpawnCommand(opts: SpawnOpts): Promise<{ binary: string; args: string[]; env?: Record<string, string> }>;
  getExitCommand(): string;

  // Hooks
  writeHooksConfig(cwd: string, hookUrl: string): Promise<void>;
  parseHookEvent(raw: unknown): NormalizedHookEvent | null;

  // Instructions
  readInstructions(worktreePath: string): string;
  writeInstructions(worktreePath: string, content: string): void;

  // Conventions
  readonly conventions: OrchestratorConventions;

  // UI helpers
  getModelOptions(): Promise<Array<{ id: string; label: string }>>;
  getDefaultPermissions(kind: 'durable' | 'quick'): string[];
  toolVerb(toolName: string): string | undefined;
  buildSummaryInstruction(agentId: string): string;
  readQuickSummary(agentId: string): Promise<{ summary: string | null; filesModified: string[] } | null>;

  // Profile support
  /** Return the env var keys this orchestrator uses for config isolation (e.g. CLAUDE_CONFIG_DIR) */
  getProfileEnvKeys(): string[];

  // Headless mode (optional — absence means headless not supported)
  buildHeadlessCommand?(opts: HeadlessOpts): Promise<HeadlessCommandResult | null>;

  // Session listing (optional — absence means session listing not supported)
  /** List available CLI sessions for the given project directory */
  listSessions?(cwd: string, profileEnv?: Record<string, string>): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string }>>;

  // Session ID extraction (optional)
  /** Extract session ID from PTY buffer output, if recognizable */
  extractSessionId?(ptyBuffer: string): string | null;

  // Structured mode adapter (optional — absence means structured mode not supported)
  /** Create a structured adapter for this provider */
  createStructuredAdapter?(): StructuredAdapter;
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
