export interface ArchInfo {
  arch: string;
  platform: string;
  rosetta: boolean;
}

export type OrchestratorId = 'claude-code' | (string & {});

export type AgentExecutionMode = 'pty' | 'headless' | 'chat';

export type SpawnMode = 'headless' | 'interactive';

/** Controls what CLI flag is used when agents need autonomous permissions. */
export type FreeAgentPermissionMode = 'auto' | 'skip-all';

export interface ProviderCapabilities {
  headless: boolean;
  structuredOutput: boolean;
  hooks: boolean;
  sessionResume: boolean;
  supportsPositionalMission?: boolean;
  supportsAutoResumeAfterUpdate?: boolean;
  permissions: boolean;
}

export interface OrchestratorInfo {
  id: string;
  displayName: string;
  shortName: string;
  badge?: string;
  capabilities: ProviderCapabilities;
  conventions?: {
    configDir: string;
    localInstructionsFile: string;
    legacyInstructionsFile: string;
    mcpConfigFile: string;
    skillsDir: string;
    agentTemplatesDir: string;
    localSettingsFile: string;
  };
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;       // AGENT_COLORS id (e.g. 'emerald')
  icon?: string;        // filename in ~/.clubhouse/project-icons/
  emoji?: string;       // single emoji character used as icon (mutually exclusive with icon)
  displayName?: string; // user-set display name (overrides `name` in UI)
  orchestrator?: OrchestratorId;
}

export type AgentStatus = 'running' | 'sleeping' | 'waking' | 'creating' | 'spawning' | 'error';
export type AgentKind = 'durable' | 'quick' | 'companion';

/**
 * Why an agent last went to sleep, and when (#2104). `idle`: the chat idle
 * timeout (`idleMinutes`); `user`: Stop; `agent`: another agent's sleep_agent
 * (`by` is its name); `crashed`: the CLI exited with an error on its own;
 * `exited`: it exited cleanly on its own.
 */
export interface AgentSleepInfo {
  reason: 'idle' | 'user' | 'agent' | 'crashed' | 'exited';
  /** ISO time it went to sleep. */
  at: string;
  idleMinutes?: number;
  by?: string;
  exitCode?: number;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  color: string;
  icon?: string;         // filename in ~/.clubhouse/agent-icons/
  emoji?: string;        // single emoji character used as icon (mutually exclusive with icon)
  worktreePath?: string;
  branch?: string;
  exitCode?: number;
  errorMessage?: string;
  /** Remote (satellite) durable agents: the satellite has a CLI session to resume. */
  hasSession?: boolean;
  /** Why it last went to sleep, for durable agents (#2104). */
  lastSleep?: AgentSleepInfo;
  mission?: string;
  model?: string;
  /**
   * Quick agents: the durable agent that spawned the run. Durable helpers
   * (#2224): their orchestrator, which the sidebar nests them under (#2231).
   */
  parentAgentId?: string;
  /** Durable agents: creating the agent failed (#2226); `errorMessage` says why. */
  creationFailed?: boolean;
  orchestrator?: OrchestratorId;
  headless?: boolean;
  /** Execution mode: 'pty' (terminal) or 'headless' (feed) */
  executionMode?: AgentExecutionMode;
  freeAgentMode?: boolean;
  /** MCP IDs active for this agent via launch wrapper */
  mcpIds?: string[];
  /** Set when the agent is resuming a previous CLI session (spinner overlay) */
  resuming?: boolean;
  /** Plugin-supplied metadata for correlating agents to domain objects (e.g. boardId, cardId). */
  pluginMetadata?: Record<string, string>;
  /** Plugin ID that owns this companion agent (v0.9+). */
  pluginOwner?: string;
  /** Path to companion workspace directory (v0.9+). */
  companionWorkspace?: string;
  /** Quick agents: the directory the run was spawned in. */
  runCwd?: string;
  /** Quick agents: HEAD sha of `runCwd` when the run was spawned (best-effort). */
  runBaseSha?: string;
}

export interface CompletedQuickAgent {
  id: string;
  projectId: string;
  name: string;
  mission: string;
  summary: string | null;
  filesModified: string[];
  exitCode: number;
  completedAt: number;
  parentAgentId?: string;
  headless?: boolean;
  transcriptPath?: string;
  costUsd?: number;
  durationMs?: number;
  toolsUsed?: string[];
  orchestrator?: string;
  model?: string;
  cancelled?: boolean;
  /** Plugin-supplied metadata carried from the spawning agent. */
  pluginMetadata?: Record<string, string>;
  /** Headless runs: last ~4 KB of stderr (or the spawn error message). */
  stderrTail?: string;
  /** Directory the run was spawned in. */
  cwd?: string;
  /** HEAD sha of `cwd` when the run was spawned, for diffing what the run changed. */
  baseSha?: string;
  /** Epoch ms the run was spawned. */
  startedAt?: number;
  freeAgentMode?: boolean;
  /** Headless runs: number of tool calls in the transcript. */
  toolCalls?: number;
  /** Headless runs: input tokens, including cache reads and writes. */
  inputTokens?: number;
  /** Headless runs: output tokens. */
  outputTokens?: number;
}

// --- Profile types ---

/** Per-orchestrator env config within a profile */
export interface OrchestratorProfileEntry {
  env: Record<string, string>;  // e.g. { CLAUDE_CONFIG_DIR: "~/.claude-work" }
}

/** Named profile containing env configs for multiple orchestrators */
export interface OrchestratorProfile {
  id: string;
  name: string;           // e.g. "Work", "Personal"
  orchestrators: Record<string, OrchestratorProfileEntry>;
}

export interface ProfilesSettings {
  profiles: OrchestratorProfile[];
}

// --- Config inheritance types ---

export interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Names of variables the CLI forwards from its own environment to this
   * stdio server, as Codex's `env_vars` key. Codex starts stdio servers with
   * a minimal environment, so a value that must stay out of config files
   * (the Clubhouse MCP nonce, #2222) reaches the server only through this.
   * Claude Code and Copilot CLI pass their whole environment to stdio
   * servers and ignore the key.
   */
  env_vars?: string[];
  type?: string;
  url?: string;
}

export interface QuickAgentDefaults {
  systemPrompt?: string;
  allowedTools?: string[];
  defaultModel?: string;
  freeAgentMode?: boolean;
}

export type SourceControlProvider = 'github' | 'azure-devops';

/** Project-level default settings applied as snapshots when creating new agents. */
export interface ProjectAgentDefaults {
  instructions?: string;
  permissions?: PermissionsConfig;
  mcpJson?: string;
  freeAgentMode?: boolean;
  sourceControlProvider?: SourceControlProvider;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  /** Default profile to use for agents in this project */
  profileId?: string;
  /** Shell command prefix prepended before the CLI binary (e.g. ". ./init.ps1 &&") */
  commandPrefix?: string;
  /** Default mission ID. Resolved at materialization to .clubhouse/missions/<id>.md content; substituted for @@mission. */
  mission?: string;
  /** Default persona template ID. Applied to every agent in the project unless the agent has its own `persona` set. */
  persona?: string;
}

/** A recorded CLI session for a durable agent */
export interface SessionInfo {
  /** CLI session ID (provider-specific format, e.g. UUID for Claude Code) */
  sessionId: string;
  /** When this session was first started */
  startedAt: string;
  /** When this session was last active */
  lastActiveAt: string;
  /** User-assigned friendly name for easy identification */
  friendlyName?: string;
}

export interface DurableAgentConfig {
  id: string;
  name: string;
  color: string;
  icon?: string;        // filename in ~/.clubhouse/agent-icons/
  emoji?: string;       // single emoji character used as icon
  branch?: string;
  worktreePath?: string;
  createdAt: string;
  model?: string;
  quickAgentDefaults?: QuickAgentDefaults;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  clubhouseModeOverride?: boolean;
  /** Last CLI session ID, used to resume previous session on wake */
  lastSessionId?: string;
  /** Why the agent last went to sleep (#2104). */
  lastSleep?: AgentSleepInfo;
  /**
   * Per-agent Chat / Terminal override. Only consulted when the experimental
   * Chat flag is on; unset means the provider's runtime setting.
   */
  runtimeMode?: import('./chat').AgentRuntimeMode;
  /**
   * Per-agent auto-sleep (#2143): 'never' or minutes idle before a chat agent
   * sleeps. Unset inherits the app's idle timeout.
   */
  idleSleep?: Exclude<import('./idle-sleep').AgentIdleSleep, 'inherit'>;
  /** History of CLI sessions for this agent */
  sessionHistory?: SessionInfo[];
  /** MCP IDs to inject via launch wrapper (when unset, falls back to project defaultMcps) */
  mcpIds?: string[];
  /** Per-MCP configuration values keyed by MCP ID then flag name */
  mcpConfigs?: Record<string, Record<string, string>>;
  /** Per-agent override for the Clubhouse MCP bridge feature. */
  mcpOverride?: boolean;
  /** Persona template ID applied at creation. Used to re-inject instructions on materialization. */
  persona?: string;
  /** Mission ID overriding the project default. Resolved to .clubhouse/missions/<id>.md content; substituted for @@mission. */
  mission?: string;
  /** Per-agent override for @@BuildCommand (falls back to project default when unset). */
  buildCommand?: string;
  /** Per-agent override for @@TestCommand (falls back to project default when unset). */
  testCommand?: string;
  /** Per-agent override for @@LintCommand (falls back to project default when unset). */
  lintCommand?: string;
  /** Per-agent override for @@SourceControlProvider (falls back to project/app resolution when unset). */
  sourceControlProvider?: SourceControlProvider;
  /** CLI agent name to load (e.g. "k8s-assistant" → --agent k8s-assistant) */
  agentFile?: string;
  /** Directory to search for the agent file (e.g. "~/.copilot/agents/" → --source ...) */
  agentSource?: string;
  /**
   * Helpers (#2224): the durable agent that owns this one. A helper is an
   * ordinary durable agent with a parent; unset means a top-level agent.
   */
  parentAgentId?: string;
  /** Helpers (#2224): the parent may dispose this agent when its work is done. */
  disposable?: boolean;
  /**
   * Helpers (#2224): ISO time the agent was disposed. A disposed agent keeps
   * its row and session history but has no worktree and never spawns.
   */
  disposedAt?: string;
  /**
   * Helpers (#2229): the parent's record of how it took this helper's work
   * (hand_off). Information only; it never disposes the helper.
   */
  handoff?: HelperHandoff;
  /**
   * Helpers (#2227): the task start_helper gave this helper, kept from when
   * its worktree is ready until it has been delivered in a spawn. Set while
   * the helper never started (a restart, a failed spawn, its orchestrator
   * gone); the next wake_helper delivers it.
   */
  pendingTask?: string;
  /**
   * Helpers (#2227): the access level start_helper was asked for (unset for
   * "same"). Every later start resolves under it, so a wake
   * never raises the helper above what its start asked for.
   */
  requestedAccess?: import('./orchestration-policy').AgentAccessLevel;
  /**
   * True when Clubhouse created `branch` for this agent, so deleting the agent
   * may delete the branch (#2226). False for a branch that already existed.
   * Unset on records from before #2226: those count as owned only when the
   * branch is `<folder>/standby`.
   */
  branchOwned?: boolean;
  /** The commit `branch` was created at. An owned branch is deleted only while it still points here. */
  branchStartSha?: string;
  /**
   * Present only while the agent is being created, or after its creation
   * failed (#2226). A ready agent has no `creation` field.
   */
  creation?: DurableAgentCreation;
  /**
   * Orchestration policy (#2228): only the fields set on this agent. Unset
   * fields come from the persona's front-matter, then the defaults. Written
   * only through services/orchestration-policy.ts, never updateDurableConfig.
   */
  orchestration?: import('./orchestration-policy').OrchestrationPolicyConfig;
}

/** How an orchestrator took a helper's work (#2229). */
export type HelperHandoffHow = 'pushed' | 'merged' | 'copied';

export const HELPER_HANDOFF_HOWS: readonly HelperHandoffHow[] = ['pushed', 'merged', 'copied'];

/** A helper's handoff record (#2229), set by its parent's hand_off tool. */
export interface HelperHandoff {
  how: HelperHandoffHow;
  /** The parent's note about what it took; may be empty. */
  note: string;
  /** ISO time of the handoff. */
  at: string;
}

/**
 * A dispose_helper call the user has to decide (#2229): the orchestrator's
 * control level is "ask-everything". Sent main → renderer, which lists it
 * under Needs you; selecting it opens the dispose confirmation (#2232).
 */
export interface HelperDisposeRequest {
  projectPath: string;
  orchestratorId: string;
  helperId: string;
  helperName: string;
  checks: HelperDisposeChecks;
  /** The orchestrator asked to force; refused under "ask-everything". */
  forceRequested: boolean;
}

/** What to do with an orchestrator's helpers when it is deleted (#2224). */
export type HelperDeleteChoice = 'dispose' | 'keep';

/**
 * What disposing a helper would lose (#2224). It blocks on dirty files,
 * unpushed commits or a check that couldn't run; `unmerged` is information
 * only, since disposing never deletes a remote branch.
 */
export interface HelperDisposeChecks {
  /** Uncommitted or untracked files in the worktree. */
  dirty: number;
  /**
   * Commits that deleting the branch would destroy: those on no remote, or,
   * when the repository has no remote, those on no other local branch.
   */
  unpushed: number;
  /** Commits not merged into the base branch; null when no base could be found. */
  unmerged: number | null;
  /** Set when a check couldn't run, or the helper is still being created. Blocks disposal. */
  error?: string;
}

export interface HelperDisposeBlock {
  agentId: string;
  name: string;
  checks: HelperDisposeChecks;
}

/**
 * The result of disposing a helper from the UI (#2232). `changed` means the
 * checks after stopping it found more at risk than `seen`, the checks the
 * user confirmed; nothing was disposed and `checks` holds the new ones.
 */
export interface HelperDisposeResult {
  ok: boolean;
  message: string;
  checks?: HelperDisposeChecks;
  changed?: boolean;
  /** The helper was running and was stopped, whatever the outcome. */
  stopped?: boolean;
}

/** What the user decided about an orchestrator's dispose request (#2232). */
export type HelperDisposeDecision = 'disposed' | 'declined';

/** start_helper's arguments, validated (#2227). */
export interface HelperStartArgs {
  name: string;
  task: string;
  persona?: string;
  cli?: string;
  model?: string;
  /** `same` or an access level; never more than the orchestrator runs with. */
  access?: string;
  branchFrom?: string;
  folder?: string;
}

/**
 * A start_helper call waiting on the user (#2234): the orchestrator's control
 * level asks before starting. Main keeps it in memory until it is approved,
 * declined, expires or its orchestrator stops orchestrating; it is sent
 * main → renderer for Needs you and the orchestrator's Helpers card.
 */
export interface HelperStartRequest {
  requestId: string;
  projectPath: string;
  orchestratorId: string;
  orchestratorName: string;
  args: HelperStartArgs;
  /** ISO times. */
  createdAt: string;
  expiresAt: string;
}

/** The result of approving or declining a helper start request. */
export interface HelperStartDecisionResult {
  ok: boolean;
  message: string;
  /** The new helper, when an approved start began creating it. */
  helperId?: string;
}

/** Result of resolving an orchestrator's helpers before it is deleted (#2224). */
export interface HelperCascadeResult {
  ok: boolean;
  message: string;
  /** Helpers that would lose work if disposed. Nothing was changed when set. */
  blocked?: HelperDisposeBlock[];
  /** Helpers that were disposed or released. */
  helperIds?: string[];
  /** Helpers whose disposal failed part way; the ones in `helperIds` were disposed. */
  failed?: Array<{ agentId: string; name: string; reason: string }>;
}

/** Persisted creation state of a durable agent (#2226). */
export interface DurableAgentCreation {
  /** 'creating' while the worktree is set up; 'failed' once it gave up (see `reason`). */
  state: 'creating' | 'failed';
  startedAt: string;
  /** The last stage reached. */
  stage?: DurableCreationStage;
  /** Why creation failed, as a sentence for the user. */
  reason?: string;
  /** True once this creation made the agent's folder itself, so cleanup after a quit may delete it. */
  folderOwned?: boolean;
  /** The Clubhouse process running the creation, so another instance leaves it alone. */
  owner?: { pid: number; instanceId: string };
  /** Refreshed while the creation runs; a creation whose owner stopped beating is treated as interrupted. */
  heartbeatAt?: string;
}

/**
 * Progress of an asynchronous durable-agent creation (#2226), in order:
 * config_created, worktree_added, config_injected, then ready. It ends early
 * with failed (plus a reason) or cancelled.
 */
export type DurableCreationStage = 'config_created' | 'worktree_added' | 'config_injected' | 'ready' | 'failed' | 'cancelled';

/** Event sent on IPC.AGENT.DURABLE_CREATION_EVENT for each creation stage (#2226). */
export interface DurableCreationEvent {
  projectPath: string;
  agentId: string;
  stage: DurableCreationStage;
  /** ISO time the stage was reached. */
  at: string;
  /** Milliseconds since the creation started. */
  elapsedMs: number;
  /** Only on 'failed'. */
  reason?: string;
  /** The agent's config at this stage; absent on 'cancelled' (the record is gone). */
  config?: DurableAgentConfig;
}

/** Where a durable agent's worktree goes and which branch it uses (#2226). All optional. */
export interface DurableWorktreeOptions {
  /** Folder under `.clubhouse/agents/`; defaults to the agent name. Validated as an agent folder name. */
  folderName?: string;
  /** Branch to check out in the worktree; defaults to `<folder>/standby`. Validated as a branch name. */
  branchName?: string;
  /** Ref the new branch starts from; defaults to HEAD. Validated as a branch name or commit id. */
  branchFrom?: string;
}

/** Everything the asynchronous create API takes (#2226). */
export interface StartDurableCreationParams extends DurableWorktreeOptions {
  name: string;
  color: string;
  model?: string;
  useWorktree?: boolean;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  mcpIds?: string[];
  mcpConfigs?: Record<string, Record<string, string>>;
  persona?: string;
  /** Helpers (#2224): make the new agent a helper of this durable agent. */
  parentAgentId?: string;
  /** Helpers (#2224): the parent may dispose the new agent when its work is done. */
  disposable?: boolean;
}

/** Maps an orchestrator ID to its wrapper subcommand */
export interface WrapperOrchestratorMapping {
  subcommand: string;
}

/** Configuration for a CLI launch wrapper. */
export interface LaunchWrapperConfig {
  /** Path or name of the wrapper binary */
  binary: string;
  /** Separator token between wrapper args and original CLI args (e.g. "--") */
  separator: string;
  /** Per-orchestrator subcommand mapping */
  orchestratorMap: Record<string, WrapperOrchestratorMapping>;
  /** Optional environment variables to set when launching through the wrapper */
  env?: Record<string, string>;
  /** Optional plugin command id that core invokes when the user clicks Refresh in the wrapper picker. */
  refreshCommandId?: string;
  /** Optional id of the plugin that contributed this preset. Used for pre-flight validation. */
  contributingPluginId?: string;
}

/** A configurable parameter for an MCP server, discovered via wrapper schema. */
export interface McpCatalogArg {
  /** CLI flag name, e.g. "--organization" */
  name: string;
  /** Human-readable description shown as placeholder/tooltip */
  description?: string;
  /** Whether this arg is required for the MCP to function */
  required: boolean;
}

/** An MCP server available through a launch wrapper */
export interface McpCatalogEntry {
  /** Short identifier used in --mcp flags (e.g. "ado", "kusto") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Brief description of the MCP's functionality */
  description: string;
  /** Configurable parameters discovered from schema (empty/absent = zero-config MCP) */
  args?: McpCatalogArg[];
}

/** Diff state for a catalog entry, computed at render time against the snapshot. */
export type McpCatalogEntryState = 'stable' | 'new' | 'changed' | 'removed';

/** A catalog entry annotated with its diff state. */
export interface McpCatalogEntryWithState extends McpCatalogEntry {
  state: McpCatalogEntryState;
}

/** Snapshot of the last user-acknowledged catalog. Persisted in project settings. */
export interface WrapperCatalogSnapshot {
  /** The catalog as it was at the time of last acknowledgement. */
  lastSeenCatalog: McpCatalogEntry[];
  /** ISO timestamp of last acknowledgement. */
  lastSeenAt: string;
}

export interface DurableConfigUpdates {
  quickAgentDefaults?: QuickAgentDefaults;
  orchestrator?: OrchestratorId;
  model?: string;
  freeAgentMode?: boolean;
  clubhouseModeOverride?: boolean;
  lastSessionId?: string | null;
  lastSleep?: AgentSleepInfo | null;
  mcpIds?: string[] | null;
  mcpConfigs?: Record<string, Record<string, string>> | null;
  /** Per-agent Chat / Terminal override; null clears it (provider default). */
  runtimeMode?: import('./chat').AgentRuntimeMode | null;
  /** Per-agent auto-sleep; 'inherit' or null clears it (app default). */
  idleSleep?: import('./idle-sleep').AgentIdleSleep | null;
  persona?: string;
  mission?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  sourceControlProvider?: SourceControlProvider | null;
}

/**
 * A single per-agent wildcard override, paired with the effective resolved value.
 * `override` is the value stored on the agent record (null when inheriting);
 * `resolved` is what the wildcard actually substitutes to (override → project
 * default → built-in fallback).
 */
export interface WildcardOverride {
  override: string | null;
  resolved: string;
}

/**
 * Resolved wildcard actuals for a single agent, used to populate the per-agent
 * simple settings form when Clubhouse Mode manages the agent. Identity fields
 * are read-only computed actuals; command/provider fields carry per-agent
 * overrides; mission/persona expose the override, the project default, and the
 * lists of authorable library items.
 */
export interface AgentWildcardSettings {
  agentName: string;
  standbyBranch: string;
  agentPath: string;
  sourceControlProvider: { override: SourceControlProvider | null; resolved: SourceControlProvider };
  buildCommand: WildcardOverride;
  testCommand: WildcardOverride;
  lintCommand: WildcardOverride;
  mission: { override: string | null; projectDefault: string | null; resolved: string | null };
  persona: { override: string | null; projectDefault: string | null; resolved: string | null };
  missions: Array<{ id: string }>;
  personas: Array<{ id: string; name: string; source: 'builtin' | 'user' | 'project' }>;
}

export interface ClubhouseModeSettings {
  enabled: boolean;
  projectOverrides?: Record<string, boolean>;
  sourceControlProvider?: SourceControlProvider;
}

export type ConfigDiffCategory = 'instructions' | 'permissions-allow' | 'permissions-deny' | 'mcp' | 'skills' | 'agent-templates';
export type ConfigDiffAction = 'added' | 'removed' | 'modified';

export interface ConfigDiffItem {
  id: string;                    // e.g. "permissions-allow:Read(.clubhouse/agents/x/**)"
  category: ConfigDiffCategory;
  action: ConfigDiffAction;
  label: string;                 // Human-readable
  agentValue?: string;           // Current agent value (resolved)
  defaultValue?: string;         // Project default value (resolved)
  rawAgentValue?: string;        // Agent value with wildcards re-applied (for propagation)
}

export interface ConfigDiffResult {
  agentId: string;
  agentName: string;
  hasDiffs: boolean;
  items: ConfigDiffItem[];
}

export interface MaterializationPreview {
  instructions: string;
  permissions: PermissionsConfig;
  mcpJson: string | null;
  skills: string[];
  agentTemplates: string[];
}

/** Provenance of a config item — who added it */
export type ConfigProvenance =
  | { source: 'user' }
  | { source: 'built-in' }
  | { source: 'plugin'; pluginId: string };

/** A config item with provenance for the management UI */
export interface ProvenancedConfigItem {
  /** Unique key for this item */
  id: string;
  /** Human label */
  label: string;
  /** The raw value */
  value: string;
  /** Who added it */
  provenance: ConfigProvenance;
}

/** Structured breakdown of all project agent default configs with provenance */
export interface ProjectConfigBreakdown {
  /** User-authored instruction text (without plugin blocks) */
  userInstructions: string;
  /** Plugin instruction blocks with attribution */
  pluginInstructionBlocks: ProvenancedConfigItem[];
  /** Permission allow rules with attribution */
  allowRules: ProvenancedConfigItem[];
  /** Permission deny rules with attribution */
  denyRules: ProvenancedConfigItem[];
  /** Skills with attribution */
  skills: ProvenancedConfigItem[];
  /** Agent templates with attribution */
  agentTemplates: ProvenancedConfigItem[];
  /** MCP servers with attribution */
  mcpServers: ProvenancedConfigItem[];
  /** IDs of plugins that have orphaned injections (plugin no longer installed) */
  orphanedPluginIds: string[];
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  /** In ADO mode, path to the sibling .md index page for this folder */
  indexPath?: string;
}

export type ExplorerTab = string;

// ── Custom protocol (clubhouse://) ─────────────────────────────────────

/**
 * A fully-resolved protocol activation dispatched from the main process to the
 * renderer. `open-file` is resolved to its owning project in main (where the
 * project list and path logic live); `open-file-not-found` reports a file that
 * no open project contains; `open-folder` asks the renderer to add a project.
 * An `open-file` may carry a 1-based line (and column) to go to.
 */
export type ResolvedProtocolAction =
  | { kind: 'open-file'; projectId: string; relativePath: string; line?: number; column?: number }
  | { kind: 'open-file-not-found'; filePath: string }
  | { kind: 'open-folder'; folderPath: string };

// ── File search types ─────────────────────────────────────────────────

export interface FileSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
  contextLines?: number;
}

export interface FileSearchMatch {
  line: number;
  column: number;
  length: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FileSearchFileResult {
  filePath: string;
  matches: FileSearchMatch[];
}

export interface FileSearchResult {
  results: FileSearchFileResult[];
  totalMatches: number;
  truncated: boolean;
}


export interface ClipboardSettings {
  clipboardCompat: boolean;
}

export interface BadgeSettings {
  enabled: boolean;
  pluginBadges: boolean;
  projectRailBadges: boolean;
  projectOverrides?: Record<string, Partial<Pick<BadgeSettings, 'enabled' | 'pluginBadges' | 'projectRailBadges'>>>;
}

export interface NotificationSettings {
  enabled: boolean;
  permissionNeeded: boolean;
  agentIdle: boolean;
  agentStopped: boolean;
  agentError: boolean;
  /** Notify when an agent deliberately requests your attention via the notify_user tool. */
  agentRequestedAttention: boolean;
  playSound: boolean;
}

// ── Sound pack types ──────────────────────────────────────────────────

export type SoundEvent =
  | 'agent-done'
  | 'error'
  | 'permission'
  | 'permission-granted'
  | 'permission-denied'
  | 'agent-wake'
  | 'agent-sleep'
  | 'agent-focus'
  | 'notification';

export const ALL_SOUND_EVENTS: readonly SoundEvent[] = [
  'agent-done',
  'error',
  'permission',
  'permission-granted',
  'permission-denied',
  'agent-wake',
  'agent-sleep',
  'agent-focus',
  'notification',
] as const;

export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  'agent-done': 'Agent Finished',
  'error': 'Error',
  'permission': 'Permission Request',
  'permission-granted': 'Permission Granted',
  'permission-denied': 'Permission Denied',
  'agent-wake': 'Agent Wake',
  'agent-sleep': 'Agent Sleep',
  'agent-focus': 'Agent Focus',
  'notification': 'General Notification',
};

export const SUPPORTED_SOUND_EXTENSIONS = ['.mp3', '.wav', '.ogg'] as const;

export interface SoundPackInfo {
  id: string;           // directory name
  name: string;         // display name from manifest or directory name
  description?: string;
  author?: string;
  sounds: Partial<Record<SoundEvent, string>>; // event → filename
  source: 'user' | 'plugin';
  pluginId?: string;    // set when source === 'plugin'
}

export interface SoundEventSettings {
  enabled: boolean;
  volume: number; // 0-100
}

/** Per-slot pack assignment: which pack provides the sound for a given event */
export interface SlotAssignment {
  packId: string; // which pack provides the sound for this slot
}

export interface SoundSettings {
  /** @deprecated Use slotAssignments instead. Kept for migration. */
  activePack?: string | null;
  /** Per-slot pack assignments. Missing key = no custom sound (OS default). */
  slotAssignments: Partial<Record<SoundEvent, SlotAssignment>>;
  eventSettings: Record<SoundEvent, SoundEventSettings>;
  projectOverrides?: Record<string, {
    /** @deprecated Use slotAssignments instead. */
    activePack?: string | null;
    slotAssignments?: Partial<Record<SoundEvent, SlotAssignment>>;
  }>;
}

export type SettingsSubPage = 'project' | 'notifications' | 'logging' | 'display' | 'editor' | 'orchestrators' | 'profiles' | 'plugins' | 'plugin-detail' | 'about' | 'updates' | 'whats-new' | 'keyboard-shortcuts' | 'annex' | 'annex-control' | 'experimental' | 'mcp' | 'goobers' | 'feedback' | 'helpers';

// --- Chat idle settings ---

/** How long a chat agent may sit idle before it's put to sleep (#2104). 0 means never. */
export interface ChatIdleSettings {
  idleTimeoutMinutes: number;
}

// --- MCP settings ---

export interface McpSettings {
  enabled: boolean;
  projectDefault?: boolean;
  projectOverrides?: Record<string, boolean>;
}

/** An agent's connection to the Clubhouse MCP: when it finished the handshake and how many tools it was last given. */
export interface AgentMcpConnection {
  connectedAt: number;
  toolCount: number | null;
}

// --- Editor settings ---

export interface EditorSettings {
  /** The command used to open files in the external editor (e.g. 'code', 'cursor', 'zed') */
  editorCommand: string;
  /** Display name for the editor (e.g. 'VS Code', 'Cursor', 'Zed') */
  editorName: string;
}

// --- Goobers settings ---

export interface GoobersSettings {
  /** Absolute path to the instance root; '' = unconfigured. */
  instanceRoot: string;
  /** Bare name resolved via login shell PATH, or an absolute path. */
  binaryPath: string;
  /** Connect on app start when a root is configured. */
  autoConnect: boolean;
  /** Allow Start/Stop from Clubhouse. */
  manageDaemon: boolean;
}

// --- Experimental settings ---

export interface ExperimentalSettings {
  /** Record of feature flags: key is the feature id, value is enabled/disabled */
  [key: string]: boolean;
}

/**
 * Set in experimental settings by the main-process migration when the removed
 * `structuredMode` flag was on, so the renderer can show a one-time notice.
 * The renderer clears it after showing the notice.
 */
export const STRUCTURED_MODE_REMOVED_NOTICE_KEY = 'structuredModeRemovedNotice';

// --- Security settings ---

export interface SecuritySettings {
  /** Allow loading file:// URLs in webview widgets and the browser view. Default: false. */
  allowLocalFileWebviews: boolean;
}

// --- Annex (LAN monitoring) types ---

export interface AnnexSettings {
  /** @deprecated Use enableServer/enableClient instead. Kept for backward compat migration. */
  enabled?: boolean;
  /** Allow remote control of this machine (run annex server + mDNS advertisement) */
  enableServer: boolean;
  /** Connect to and control satellites (run annex client + Bonjour discovery) */
  enableClient: boolean;
  deviceName: string;
  /** Display alias for this instance (defaults to os.hostname()) */
  alias: string;
  /** Icon identifier for this instance (defaults to 'computer') */
  icon: string;
  /** Color identifier from AGENT_COLORS palette (defaults to 'indigo') */
  color: string;
  /** Whether to auto-reconnect to satellites after disconnection */
  autoReconnect: boolean;
}

export interface AnnexStatus {
  /** SHA-256 of the active TLS leaf certificate DER, for mobile pin verification. */
  tlsCertificateFingerprint?: string;
  advertising: boolean;
  port: number;
  pin: string;
  connectedCount: number;
  /** SHA-256 fingerprint of this instance's public key (colon-separated hex) */
  fingerprint: string;
  /** Display alias for this instance */
  alias: string;
  /** Icon identifier */
  icon: string;
  /** Color identifier */
  color: string;
}

// ── Annex peer types ──────────────────────────────────────────────────

/** Role of a peer relative to this machine. */
export type AnnexPeerRole = 'controller' | 'satellite';

export interface AnnexPeer {
  /** Certificate bound during HTTPS PIN pairing; required by mobile control. */
  tlsCertificateFingerprint?: string;
  /** SHA-256 fingerprint of the peer's public key */
  fingerprint: string;
  /** Base64-encoded Ed25519 public key (DER/SPKI) */
  publicKey: string;
  /** Display alias */
  alias: string;
  /** Icon identifier */
  icon: string;
  /** Color identifier */
  color: string;
  /** ISO timestamp of when the pairing was established */
  pairedAt: string;
  /** ISO timestamp of last successful connection */
  lastSeen: string;
  /**
   * The role of this peer relative to us:
   * - 'controller': This peer controls us (we are their satellite)
   * - 'satellite': This peer is our satellite (we control them)
   * Legacy peers without a role are treated as 'satellite' for backward compat.
   */
  role?: AnnexPeerRole;
}

// ── Annex client (controller) types ───────────────────────────────────

export const ANNEX_PROTOCOL_VERSION = 2;

export type SatelliteConnectionState = 'disconnected' | 'discovering' | 'connecting' | 'connected';

export interface SatelliteConnection {
  id: string;
  alias: string;
  icon: string;
  color: string;
  fingerprint: string;
  state: SatelliteConnectionState;
  host: string;
  mainPort: number;
  pairingPort: number;
  snapshot: SatelliteSnapshot | null;
  lastError: string | null;
}

/** Summary of an installed plugin sent in the satellite snapshot. */
export interface SnapshotPluginSummary {
  id: string;
  name: string;
  version: string;
  scope: 'project' | 'app' | 'dual';
  contributes?: unknown;
  annexEnabled: boolean;
}

export interface SatelliteSnapshot {
  projects: Project[];
  agents: Record<string, Agent[]>;
  quickAgents: Record<string, unknown[]>;
  theme: unknown;
  orchestrators: unknown;
  pendingPermissions: unknown[];
  lastSeq: number;
  plugins?: SnapshotPluginSummary[];
  agentsMeta?: unknown;
  protocolVersion?: number;
  /** Project icon data URLs keyed by project ID. */
  projectIcons?: Record<string, string>;
  /** Agent icon data URLs keyed by agent ID. */
  agentIcons?: Record<string, string>;
  /** Per-project canvas state keyed by satellite project ID. */
  canvasState?: Record<string, { canvases: unknown[]; activeCanvasId: string }>;
  /** App-level (global) canvas state from the satellite. */
  appCanvasState?: { canvases: unknown[]; activeCanvasId: string } | null;
  /** Whether the satellite session is currently paused. */
  sessionPaused?: boolean;
  /** Group projects from the satellite. */
  groupProjects?: unknown[];
  /** Bulletin digests per group project ID. */
  bulletinDigests?: Record<string, unknown[]>;
  /** Group project members per group project ID. */
  groupProjectMembers?: Record<string, Array<{ agentId: string; agentName: string; status: string }>>;
  /** The satellite's OS and PTY backend (#2352). Absent from older satellites. */
  ptyHost?: import('./annex-pty').AnnexPtyHost;
}

// --- Auto-update types ---

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdateArtifact {
  url: string;
  sha256: string;
  size?: number;
}

export interface UpdateManifest {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
  releaseMessage?: string;
  mandatory?: boolean;
  artifacts: Record<string, UpdateArtifact>;
  /**
   * Known-bad chat CLI versions (remote kill switch). Entries look like
   * `{ driver?, provider?, versions?, range?: { from?, to? }, reason }` and
   * are validated on receipt (chat-version-policy.ts).
   */
  chatCliDenylist?: unknown;
}

export interface UpdateStatus {
  state: UpdateState;
  availableVersion: string | null;
  releaseNotes: string | null;
  releaseMessage: string | null;
  downloadProgress: number;  // 0-100
  error: string | null;
  downloadPath: string | null;
  artifactUrl: string | null;
  /** True when a previous apply attempt for this version was detected on startup */
  applyAttempted: boolean;
}

export interface UpdateSettings {
  autoUpdate: boolean;
  previewChannel: boolean;
  lastCheck: string | null;
  dismissedVersion: string | null;
  lastSeenVersion: string | null;
}

export interface MarketplaceSettings {
  showBetaPlugins: boolean;
}

export interface PendingReleaseNotes {
  version: string;
  releaseNotes: string;
}

export interface VersionHistoryEntry {
  version: string;
  releaseDate: string;
  releaseMessage: string;
  releaseNotes: string;
}

export type VersionHistory = VersionHistoryEntry[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export type LogRetention = 'low' | 'medium' | 'high' | 'unlimited';

export interface LogRetentionConfig {
  retentionDays: number;
  maxTotalBytes: number;
}

export const LOG_RETENTION_TIERS: Record<LogRetention, LogRetentionConfig> = {
  low:       { retentionDays: 3,  maxTotalBytes: 50  * 1024 * 1024 },
  medium:    { retentionDays: 7,  maxTotalBytes: 200 * 1024 * 1024 },
  high:      { retentionDays: 30, maxTotalBytes: 500 * 1024 * 1024 },
  unlimited: { retentionDays: 0,  maxTotalBytes: 0 },
};

export interface LoggingSettings {
  enabled: boolean;
  namespaces: Record<string, boolean>;
  retention: LogRetention;
  minLogLevel: LogLevel;
  /**
   * Record telemetry signals (spans, events, exceptions, metric aggregates)
   * to local `telemetry-*.jsonl` files while `enabled` is on. Never exported.
   * Missing in files from before #2278; treated as on.
   */
  telemetryRecording?: boolean;
  /**
   * Detail level of local telemetry recording, which is also the most any
   * export destination can send (spec §6.12). Detailed adds per-IPC and agent
   * tool-call spans. Missing means Standard.
   */
  telemetryLevel?: LocalTelemetryLevel;
  /** Set once the one-time level migration from export settings has run (#2289). */
  telemetryLevelMigrated?: boolean;
  /**
   * The user dismissed the one-time note that debug diagnostic lines share
   * the hourly diag budget (#2299). Shown while the minimum level is debug.
   */
  diagBudgetNoteDismissed?: boolean;
}

export type LocalTelemetryLevel = 'standard' | 'detailed';

/** Built-in theme IDs. Plugin themes use arbitrary string IDs prefixed with `plugin:`. */
export type BuiltinThemeId =
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'solarized-dark'
  | 'terminal'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'gruvbox-dark'
  | 'cyberpunk';

/** Theme IDs — builtin themes plus any plugin-contributed themes. */
export type ThemeId = BuiltinThemeId | (string & {});

export interface ThemeColors {
  base: string;
  mantle: string;
  crust: string;
  text: string;
  subtext0: string;
  subtext1: string;
  surface0: string;
  surface1: string;
  surface2: string;
  accent: string;
  link: string;
  /** Semantic notification colors — WCAG AA compliant against base */
  warning: string;
  error: string;
  info: string;
  success: string;
  accent2: string;
  overlay: string;
  overlay0: string;
  overlay1: string;
  /** Mascot brand tints (#2019). Unset falls back to the defaults in index.css. */
  brandClaude?: string;
  brandClaudeInk?: string;
  brandCopilot?: string;
  /** Unset means the theme's text color. */
  brandCodex?: string;
}

export interface HljsColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  variable: string;
  regexp: string;
  tag: string;
  attribute: string;
  symbol: string;
  meta: string;
  addition: string;
  deletion: string;
  property: string;
  punctuation: string;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeFonts {
  /** UI font family (applied to body and all UI elements). */
  ui?: string;
  /** Monospace font family (applied to code, pre, kbd, terminal). */
  mono?: string;
}

export interface ThemeGradients {
  /** CSS gradient applied to the page background. */
  background?: string;
  /** CSS gradient for elevated surface elements. */
  surface?: string;
  /** CSS gradient for accent/highlight elements. */
  accent?: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  type: 'dark' | 'light';
  colors: ThemeColors;
  hljs: HljsColors;
  terminal: TerminalColors;
  fontOverride?: string;
  /** Custom font families (experimental). */
  fonts?: ThemeFonts;
  /** CSS gradients (experimental). */
  gradients?: ThemeGradients;
}

export interface GitStatusFile {
  path: string;
  origPath?: string;  // For renames/copies: the original path
  status: string;
  staged: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitInfo {
  branch: string;
  branches: string[];
  status: GitStatusFile[];
  log: GitLogEntry[];
  hasGit: boolean;
  ahead: number;
  behind: number;
  remote: string;
  stashCount: number;
  hasConflicts: boolean;
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

/** One file from `git diff --numstat` (plus untracked files) against a base. */
export interface GitNumstatEntry {
  /** Path relative to the repository root (the new path for renames). */
  path: string;
  added: number;
  removed: number;
  /** True for binary files, whose line counts are reported as 0. */
  binary: boolean;
}

export interface GitWorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Short label for display (last path segment). */
  label: string;
  /** Current branch checked out in this worktree (empty string if detached). */
  branch: string;
  /** Whether this is the main/bare worktree. */
  isBare: boolean;
}

export interface GitCommitFileEntry {
  path: string;
  status: string;
  origPath?: string;
}

export interface GitCommitDetail {
  hash: string;
  files: GitCommitFileEntry[];
}

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  scope: 'project' | 'global';
}

export interface SkillEntry {
  name: string;
  path: string;
  hasReadme: boolean;
}

export interface AgentTemplateEntry {
  name: string;
  path: string;
  hasReadme: boolean;
}

export type HookEventKind = 'pre_tool' | 'post_tool' | 'tool_error' | 'stop' | 'notification' | 'permission_request' | 'permission_resolved';

export interface AgentHookEvent {
  kind: HookEventKind;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  message?: string;
  /** Human-readable verb for the tool, resolved by the provider (e.g. "Editing file") */
  toolVerb?: string;
  /** Pairs a pre_tool event with its post_tool event (the tool_use block id). */
  toolUseId?: string;
  timestamp: number;
}

export interface SpawnAgentParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: AgentKind;
  model?: string;
  mission?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  /** When true, attempt to resume the previous CLI session instead of starting fresh */
  resume?: boolean;
  /** Specific session ID to resume (provider-specific format) */
  sessionId?: string;
  /** Permission mode override for resume (preserves pre-restart mode) */
  permissionMode?: FreeAgentPermissionMode;
  /** CLI agent name to load (e.g. --agent k8s-assistant) */
  agentFile?: string;
  /** Source directory for agent file (e.g. --source ~/.copilot/agents/) */
  agentSource?: string;
}

export type AgentDetailedState = 'idle' | 'working' | 'needs_permission' | 'tool_error';

export interface AgentDetailedStatus {
  state: AgentDetailedState;
  message: string;
  toolName?: string;
  timestamp: number;
}

export interface AnnexApprovalResponse {
  type: 'permission_response';
  agentId: string;
  requestId: string;
  approved: boolean;
  reason?: string;
}

export interface WorktreeStatus {
  isValid: boolean;
  branch: string;
  uncommittedFiles: GitStatusFile[];
  unpushedCommits: GitLogEntry[];
  hasRemote: boolean;
  /**
   * Set when a check could not run: the worktree is not known to be clean,
   * and the delete dialog says so instead of offering a plain delete.
   */
  checkError?: string;
}

export interface DeleteResult {
  ok: boolean;
  message: string;
}

// ── Canvas state sync (main window ↔ pop-out windows) ─────────────────

export type CanvasMutation =
  | { type: 'addView'; viewType: string; position: { x: number; y: number } }
  | { type: 'addPluginView'; pluginId: string; qualifiedType: string; label: string; position: { x: number; y: number }; defaultSize?: { width: number; height: number } }
  | { type: 'removeView'; viewId: string }
  | { type: 'moveView'; viewId: string; position: { x: number; y: number } }
  | { type: 'moveViews'; positions: Record<string, { x: number; y: number }> }
  | { type: 'resizeView'; viewId: string; size: { width: number; height: number } }
  | { type: 'focusView'; viewId: string }
  | { type: 'updateView'; viewId: string; updates: Record<string, unknown> }
  | { type: 'setViewport'; viewport: { panX: number; panY: number; zoom: number } }
  | { type: 'zoomView'; viewId: string | null }
  | { type: 'selectView'; viewId: string | null }
  // Canvas tab management (for pop-out + annex sync)
  | { type: 'addCanvas' }
  | { type: 'removeCanvas'; canvasId: string }
  | { type: 'renameCanvas'; canvasId: string; name: string }
  | { type: 'setActiveCanvas'; canvasId: string }
  // Zone operations
  | { type: 'removeZone'; zoneId: string; removeContents: boolean }
  | { type: 'updateZoneTheme'; zoneId: string; themeId: string };

export interface CanvasStateSnapshot {
  canvasId: string;
  name: string;
  views: unknown[]; // CanvasView[] — kept as unknown to avoid circular dependency
  viewport: { panX: number; panY: number; zoom: number };
  nextZIndex: number;
  zoomedViewId: string | null;
  selectedViewId?: string | null;
  /** Project context for annex canvas sync (absent in local-only broadcasts). */
  projectId?: string;
  /** Storage scope: 'global' for app mode, 'project' for project mode. */
  scope?: string;
  /** All canvas tab metadata — enables tab sync for annex controllers. */
  allCanvasTabs?: Array<{ id: string; name: string }>;
  /** Active canvas tab ID on the source — enables tab sync for annex controllers. */
  activeCanvasId?: string;
  /** Wire definitions for remote canvas sync — ensures wires are visible on the controller. */
  wireDefinitions?: Array<{
    agentId: string;
    targetId: string;
    targetKind: string;
    label: string;
    agentName?: string;
    targetName?: string;
    projectName?: string;
    instructions?: Record<string, string>;
    disabledTools?: string[];
  }>;
  /** Zone wire definitions for remote canvas sync — ensures zone wires (and
   *  their single visual wire to the zone) survive the annex round-trip. */
  zoneWireDefinitions?: Array<{
    id: string;
    sourceZoneId: string;
    targetId: string;
    targetType: 'zone' | 'agent' | 'group-project' | 'browser';
  }>;
}

// --- Session Resume on Update types ---

export type ResumeStrategy = 'auto' | 'manual';

export interface RestartSessionEntry {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  sessionId: string | null;
  /**
   * Whether the agent had started a CLI session when the state was captured:
   * true with a `sessionId`; false when none existed (the agent was still
   * starting), so it is spawned fresh with its mission; absent when it can't
   * be told (lookup failed, a provider without session listing, or state
   * written by an older version), which resumes the most recent session.
   */
  sessionStarted?: boolean;
  resumeStrategy: ResumeStrategy;
  worktreePath?: string;
  kind: AgentKind;
  /**
   * The task the agent was running. Never re-sent to a resumed session (#2074);
   * sent only when the agent never started a session (`sessionStarted: false`)
   * and is spawned fresh instead.
   */
  mission?: string;
  model?: string;
  permissionMode?: FreeAgentPermissionMode;
  /** Whether the agent was running in free-agent (dangerously skip permissions) mode */
  freeAgentMode?: boolean;
}

export interface RestartSessionState {
  version: number;
  capturedAt: string;
  appVersion: string;
  sessions: RestartSessionEntry[];
}

export interface LiveAgentInfo {
  agentId: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  runtime: string;
  isWorking: boolean;
  lastActivity: number | null;
  /**
   * Whether this agent will be resumed automatically across an update restart.
   * Computed by the main process from the same provider capability the capture
   * path uses, so the badge shown before restarting matches what then happens.
   */
  resumeStrategy: ResumeStrategy;
}

