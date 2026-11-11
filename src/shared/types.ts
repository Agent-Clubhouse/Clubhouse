import type { AnnexProblem } from './annex-problems';

/** Whether the clubhouse command is installed (#2598). Only a packaged build can install it. */
export interface CliInstallStatus {
  supported: boolean;
  installed: boolean;
  /** Where the command is. */
  commandPath?: string;
  /** What the user still has to do to run it. */
  note?: string;
}

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
  /** The CLI takes MCP servers as launch flags, not only from the folder's MCP file. */
  mcpLaunchFlags?: boolean;
  conventions?: {
    configDir: string;
    localInstructionsFile: string;
    legacyInstructionsFile: string;
    mcpConfigFile: string;
    skillsDir: string;
    /** The skills folder relative to the worktree, when it isn't `<configDir>/<skillsDir>`. */
    skillsRoot?: string;
    agentTemplatesDir: string;
    localSettingsFile: string;
    permissionRules?: boolean;
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
  /**
   * Its git remote as a key (`github.com/org/repo`), on a project from another
   * machine's snapshot: for suggesting a link with the same project here (#3066).
   */
  repoKey?: string;
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
  /**
   * Durable helpers whose orchestrator is in another project (#2514): that
   * project's path, from the config's `parentProjectPath`. Unset means the
   * parent is in this agent's own project.
   */
  parentProjectPath?: string;
  /** The open project at `parentProjectPath`, when there is one. */
  parentProjectId?: string;
  /** Durable agents: creating the agent failed (#2226); `errorMessage` says why. */
  creationFailed?: boolean;
  orchestrator?: OrchestratorId;
  headless?: boolean;
  /** Execution mode: 'pty' (terminal) or 'headless' (feed) */
  executionMode?: AgentExecutionMode;
  freeAgentMode?: boolean;
  /** Access (#2761); `freeAgentMode` is the legacy field derived from it. */
  access?: import('./agent-access').AccessLevel;
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
  /** Quick agents started from a template (D25): its id, so Retry keeps it. */
  managedTemplateId?: string;
  /** What this launch added to or left out of its template (#2928), for Details and Retry. */
  managedQuickChanges?: QuickRunChanges;
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
  /** The level the run started at (#2761), for Retry. */
  access?: import('./agent-access').AccessLevel;
  /** Headless runs: number of tool calls in the transcript. */
  toolCalls?: number;
  /** Headless runs: input tokens, including cache reads and writes. */
  inputTokens?: number;
  /** Headless runs: output tokens. */
  outputTokens?: number;
  /** The template the run started from (D25), for Retry. */
  managedTemplateId?: string;
  /** What the run added to or left out of its template (#2928), for Retry. */
  managedQuickChanges?: QuickRunChanges;
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
  /** Access (#2761); `freeAgentMode` is the legacy field derived from it. */
  access?: import('./agent-access').AccessLevel;
}

export type SourceControlProvider = 'github' | 'azure-devops';

/** The app-level source control provider (D61), in source-control-settings.json. Unset falls back to the old Clubhouse Mode value. */
export interface SourceControlSettings {
  provider?: SourceControlProvider;
}

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
  /**
   * @deprecated Provider profiles were removed (#2749): every agent runs on its
   * provider's own login. Old project settings may still hold an id. Nothing
   * applies it; only the one-time removal log reads it.
   */
  profileId?: string;
  /** `off` stops `cli: "auto"` in this project (#2671). A project can't turn it on. */
  helperAuto?: 'off';
  /** Shell command prefix prepended before the CLI binary (e.g. ". ./init.ps1 &&") */
  commandPrefix?: string;
  /** Default mission ID. Only Clubhouse Mode filled @@Mission with it; retired (#2901), read only by the switch to managed. */
  mission?: string;
  /**
   * @deprecated Personas were retired (#2901). A project default persona id
   * saved before then. Only the switch to managed reads it (managed-agents/
   * legacy-migration); nothing writes or applies it.
   */
  persona?: string;
}

/**
 * Changed fields of a project's defaults. A key that's missing stays as it is;
 * `null` removes it (#3244).
 */
export type ProjectAgentDefaultsPatch = { [K in keyof ProjectAgentDefaults]?: ProjectAgentDefaults[K] | null };

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
  /** The CLI that made this session; only that CLI can resume it (#2593). Unset on older entries until the agent changes CLI. */
  orchestrator?: OrchestratorId;
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
  /** The context choice for this CLI and model (#2660): a provider's choice value, read at launch and resume. Absent: the CLI decides. */
  contextWindow?: string;
  /** Why a saved context choice was cleared, shown until the next choice. */
  contextWindowNotice?: string;
  /**
   * The reasoning effort (#2671), passed on every launch. start_helper writes
   * it, and so do a managed agent's Settings and templates. A new model or CLI
   * clears it, since a level means something only to the model it was checked
   * against.
   */
  effort?: string;
  /** What start_helper decided and why (#2671). A later change of model or CLI clears it. */
  routing?: import('./helper-routing').HelperRouting;
  quickAgentDefaults?: QuickAgentDefaults;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  /** Access (#2761): the level its CLI starts at. `freeAgentMode` is still written beside it, derived, for older phones and a rollback. */
  access?: import('./agent-access').AccessLevel;
  /** Clubhouse Mode turned off for this agent. Clubhouse Mode was retired (#2901); read only by the switch to managed. */
  clubhouseModeOverride?: boolean;
  /** Last CLI session ID, used to resume previous session on wake */
  lastSessionId?: string;
  /**
   * Native sessions that kept failing every turn (#3240), newest last. They
   * are never resumed again, and a session's late end never makes one the
   * resume id again.
   */
  quarantinedSessionIds?: string[];
  /** Why the agent last went to sleep (#2104). */
  lastSleep?: AgentSleepInfo;
  /**
   * Per-agent Chat / CLI override. Only consulted when the experimental
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
  /**
   * @deprecated Personas were retired (#2901). The persona id an agent had
   * before then, kept as a legacy field: the switch to managed reads it
   * (managed-agents/legacy-migration) and drops it. Nothing writes it, and an
   * old Dispatcher's `persona: 'dispatcher'` means nothing.
   */
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
  /**
   * Cross-project helpers (#2511): the project path the parent lives in, set
   * only when that is another project. Unset means the parent is in this
   * project. A path, not a project id: project ids change on every re-add.
   */
  parentProjectPath?: string;
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
  requestedAccess?: import('./orchestration-policy').HelperRequestedAccess;
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
   * fields come from the defaults. Written
   * only through services/orchestration-policy.ts, never updateDurableConfig.
   */
  orchestration?: import('./orchestration-policy').OrchestrationPolicyConfig;
  /**
   * Clubhouse-managed agents (#2819): what the agent is built from. Present
   * means Clubhouse writes its instructions, skills and MCP servers into its
   * folder at each session start. Written only through
   * services/managed-agents, never updateDurableConfig.
   */
  managed?: import('./managed-agents-types').ManagedAgentSetup;
  /**
   * The template this agent's helpers start from when start_helper names
   * none (#2895). Unset, or a template that no longer exists, means the app's
   * default helper template.
   */
  helperTemplateId?: string;
  /**
   * Unmanaged agents only (#2893): false turns off Clubhouse's hooks and MCP
   * bridge for a plain CLI. Unset means on.
   */
  clubhouseFeatures?: false;
  /**
   * Set when Clubhouse switched this agent to managed on its own (D59). Kept
   * after the notice is dismissed, so it is never switched automatically
   * again. Written only through services/managed-agents.
   */
  managedMigration?: import('./managed-agents-types').ManagedMigration;
  /**
   * When this agent first went from unmanaged to managed, by hand or on its
   * own (D59). Written in the same save as its first setup, and kept after
   * Stop managing, so Clubhouse never switches it on its own again.
   */
  switchedToManagedAt?: string;
  /** The last automatic switch to managed failed (D59). Cleared when it switches. */
  managedMigrationFailure?: import('./managed-agents-types').ManagedMigrationFailure;
  /**
   * When the orchestration fields the retired persona layer (a project or
   * user `orchestrator.md`, or its persona) decided for this unmanaged agent
   * were kept as its own (D62). Set once, so it isn't done again. A new
   * agent gets it at creation: it never had that layer.
   */
  personaLayerCarriedAt?: string;
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
  /** The project the helper's row is in. */
  projectPath: string;
  /** The orchestrator's project, when it is not the helper's (#2515). */
  orchestratorProjectPath?: string;
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
  /** @deprecated Accepted and ignored (#2901): helpers start from a template. start_helper says so in `personaNote`. */
  persona?: string;
  cli?: string;
  model?: string;
  /** A reasoning effort level the helper's model takes (#2671). */
  effort?: string;
  /** How demanding the task is (#2671): model and effort come from the helper presets for the helper's CLI. */
  difficulty?: string;
  /** `same` or an access level; never more than the orchestrator runs with. */
  access?: string;
  branchFrom?: string;
  folder?: string;
  /**
   * Another registered project to start the helper in (#2515), by name or
   * path. A held request keeps the resolved path; unset for the
   * orchestrator's own project.
   */
  project?: string;
  /**
   * Clubhouse-managed helpers (#2899): the template to build the helper from.
   * Unset means the orchestrator's helper template, else the app's default
   * helper template (#2895).
   */
  template?: string;
  /** Agent part ids to add for this helper only (#2899). Nothing is saved to the template. */
  addParts?: string[];
  /** Agent part ids to leave out for this helper only (#2899). */
  removeParts?: string[];
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
  /** A provider this start names looked unwell when it was asked. Decided again at approval, and it never blocks. */
  warning?: import('./helper-routing').HelperStartWarning;
}

/** The result of approving or declining a helper start request. */
export interface HelperStartDecisionResult {
  ok: boolean;
  message: string;
  /** A provider the start named looked unwell. It started anyway. */
  warning?: import('./helper-routing').HelperStartWarning;
  /** The new helper, when an approved start began creating it. */
  helperId?: string;
  /** A refused start's stable code, where it has one (no_valid_mapping, #2671). */
  code?: string;
}

/**
 * A helper and the project its row is in (#2514), from LIST_HELPERS: an
 * orchestrator's helpers can be in any registered project. `projectId` is the
 * project store's id for `projectPath`, when it has one.
 */
export interface HelperInProject {
  projectId?: string;
  projectPath: string;
  config: DurableAgentConfig;
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
  /** This window's temporary row id. Removed with creation when ready; never part of an agent payload. */
  requestId?: string;
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
  /** Correlates a renderer's temporary row with the record while creation is pending. */
  creationRequestId?: string;
  name: string;
  color: string;
  model?: string;
  /** Only start_helper sets it (#2671); the renderer's creation request doesn't carry it. */
  effort?: string;
  /** Only start_helper sets it (#2671). */
  routing?: import('./helper-routing').HelperRouting;
  useWorktree?: boolean;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  /** Access (#2761); `freeAgentMode` is the legacy field derived from it. */
  access?: import('./agent-access').AccessLevel;
  mcpIds?: string[];
  mcpConfigs?: Record<string, Record<string, string>>;
  /** Helpers (#2224): make the new agent a helper of this durable agent. */
  parentAgentId?: string;
  /**
   * Cross-project helpers (#2511): the project the parent lives in, when it
   * is not the project the agent is created in. Ignored without parentAgentId.
   */
  parentProjectPath?: string;
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
  /** A provider's choice for this model; null clears it. Refused when the model doesn't offer it. */
  contextWindow?: string | null;
  freeAgentMode?: boolean;
  /** Access (#2761). Also sets the legacy `freeAgentMode`. A `freeAgentMode` alone maps to the nearest level. */
  access?: import('./agent-access').AccessLevel;
  lastSessionId?: string | null;
  lastSleep?: AgentSleepInfo | null;
  mcpIds?: string[] | null;
  mcpConfigs?: Record<string, Record<string, string>> | null;
  /** Per-agent Chat / CLI override; null clears it (provider default). */
  runtimeMode?: import('./chat').AgentRuntimeMode | null;
  /** Per-agent auto-sleep; 'inherit' or null clears it (app default). */
  idleSleep?: import('./idle-sleep').AgentIdleSleep | null;
  /** Reasoning effort for the model it runs; null clears it (the CLI's default). Applied after a model or CLI change. */
  effort?: string | null;
  /** The template its helpers start from; null clears it (the app's default helper template). */
  helperTemplateId?: string | null;
  mission?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  sourceControlProvider?: SourceControlProvider | null;
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
 * no open project contains (the desktop previews it read-only); `open-folder`
 * asks the renderer to add a project. File actions may carry a 1-based line
 * (and column) to go to.
 */
export type ResolvedProtocolAction =
  | { kind: 'open-file'; projectId: string; relativePath: string; line?: number; column?: number }
  | { kind: 'open-file-not-found'; filePath: string; line?: number; column?: number }
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

export type SettingsSubPage = 'project' | 'notifications' | 'logging' | 'display' | 'editor' | 'orchestrators' | 'plugins' | 'plugin-detail' | 'about' | 'updates' | 'whats-new' | 'keyboard-shortcuts' | 'annex' | 'annex-control' | 'experimental' | 'goobers' | 'feedback' | 'helpers' | 'smart-selection' | 'dispatcher' | 'actions'
  // Clubhouse-managed agents (#2819).
  | 'managed-blocks' | 'managed-skills' | 'managed-mcp' | 'managed-templates' | 'managed-orchestration' | 'managed-switch';

// --- Chat idle settings ---

/** How long a chat agent may sit idle before it's put to sleep (#2104). 0 means never. */
export interface ChatIdleSettings {
  idleTimeoutMinutes: number;
}

// --- MCP settings ---

/** An agent's connection to the Clubhouse MCP: when it finished the handshake and how many tools it was last given. */
export interface AgentMcpConnection {
  connectedAt: number;
  toolCount: number | null;
}

/** A link the Dispatcher made, as the Connections card shows it (#2661). */
export interface DispatcherLink {
  agentId: string;
  targetId: string;
  agentName: string;
  targetName: string;
  /** `active` is bound now. `suspended` is saved but not bound; `reason` says why. */
  status: 'active' | 'suspended';
  reason?: 'dispatcher_off' | 'store_unwritable' | 'not_connected_to_dispatcher';
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

/**
 * Set by the same migration when the removed `copilotLegacyAcp` opt-in was on
 * (#2868), for a one-time notice that Copilot chat now uses the SDK. The
 * renderer clears it after showing the notice.
 */
export const COPILOT_ACP_REMOVED_NOTICE_KEY = 'copilotLegacyAcpRemovedNotice';

/** The Dispatcher debug view's switch (#3188); renderer/features/dispatcher/dispatcherDebug.ts reads it. */
export const DISPATCHER_DEBUG_FLAG = 'dispatcherDebug';

/**
 * Experimental features that count only in preview-eligible builds, where the
 * Experimental settings page is shown. Elsewhere they read as off and stay saved,
 * so a stable build never runs a feature it offers no way to turn off.
 * Graduated flags (`chat`, `richChatContent`, `themeGradients`) aren't here: every build honours them as saved.
 */
export const PREVIEW_ONLY_EXPERIMENTAL_FLAGS: readonly string[] = [
  'goobers',
  DISPATCHER_DEBUG_FLAG,
  'copilotSdk', // Legacy preference retained for downgrade compatibility only.
];

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
  /** Listen only on loopback and disable local discovery. Off when absent. */
  loopbackOnly?: boolean;
  deviceName: string;
  /** Display alias for this instance (defaults to os.hostname()) */
  alias: string;
  /** Icon identifier for this instance (defaults to 'computer') */
  icon: string;
  /** Color identifier from AGENT_COLORS palette (defaults to 'indigo') */
  color: string;
  /** Whether to auto-reconnect to satellites after disconnection */
  autoReconnect: boolean;
  /**
   * A name or address other devices can also reach this machine by, such as its
   * tailnet name (#3058). Added to the pairing link and the phone's routes.
   */
  reachableAs?: string;
  /**
   * Annex Network for this machine (#3061). On (the default when unset), a new
   * pairing with another desktop that has it on joins the network. Off, pairings
   * are one-to-one as before.
   */
  networkEnabled?: boolean;
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
  /** `clubhousego://pair` link for the settings QR code; set while the TLS server is up. */
  pairingUrl?: string;
  /** The hosts in pairingUrl, best first, for manual pairing. */
  pairingHosts?: string[];
  /** Pairing is paused after too many wrong PINs, until allowed again in Settings. */
  pairingPaused?: boolean;
}

// ── Annex peer types ──────────────────────────────────────────────────

/**
 * Role of a peer relative to this machine. `member`: both are in the same Annex
 * Network (#3061), so each controls the other.
 */
export type AnnexPeerRole = 'controller' | 'satellite' | 'member';

export interface AnnexPeer {
  /**
   * SHA-256 of the peer's TLS certificate, pinned during HTTPS PIN pairing.
   * Every connection, either way, must present exactly this certificate. An
   * entry without one is from an older version and needs pairing again.
   */
  tlsCertificateFingerprint?: string;
  /** The satellite's certificate (PEM), stored on our record of a satellite so outbound connections can pin it. */
  tlsCertificatePem?: string;
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
   * Entries without a role are from an older version and need pairing again.
   */
  role?: AnnexPeerRole;
  /** For a satellite: addresses it was reached at or listed in its pairing link, most recently reached first (#3058). */
  knownHosts?: string[];
  /** TLS ports per known host, keyed by lowercase host. Older records fall back to mainPort. */
  hostPorts?: Record<string, number>;
  /** Legacy default TLS port, kept for hosts without a per-address port and older builds. */
  mainPort?: number;
  /** Endpoints learned from membership announcements, kept separate from this machine's private forwards. */
  announcedReach?: { hosts: string[]; port?: number };
  /** For a satellite: a host name or address the person typed, such as a tailnet name. */
  typedHost?: string;
  /** For a network member: a computer or a phone, as it said when it joined. */
  kind?: 'desktop' | 'phone';
  /** For a network member: the fingerprint of the member that added it (this machine's own when paired here). */
  addedBy?: string;
  /**
   * For a network member: the pairing that put it in the network (#3107), with
   * `pairedAt` as that pairing's join time. Unknown until learned for a desktop
   * this machine paired with, whose own pairing was made elsewhere.
   */
  pairingId?: string;
}

/** A peer as Settings lists it. */
export interface AnnexPeerListing extends AnnexPeer {
  /** Older pairing (or one we can't verify): refused until it's paired again. */
  needsPairing: boolean;
}

/**
 * Where a paired device stands, as Settings shows it.
 * - `connected`: a live connection either way.
 * - `connecting`: this machine is connecting to it, or looking for it on the network.
 * - `offline`: paired, with no connection now.
 * - `needs-pairing`: refused until it's paired again.
 * - `removing`: removed from the network, and some members haven't heard yet (#3061).
 */
export type AnnexDeviceState = 'connected' | 'connecting' | 'offline' | 'needs-pairing' | 'removing';

/**
 * One paired device (#3057): the single list Settings is built from, whichever
 * way the pairing goes. Keyed by identity fingerprint.
 */
export interface AnnexDevice {
  fingerprint: string;
  alias: string;
  icon: string;
  color: string;
  /**
   * How it's paired with this machine: it controls this machine (`controller`),
   * or this machine controls it (`satellite`). Null for a pairing from before
   * roles, which needs pairing again.
   */
  role: AnnexPeerRole | null;
  /** For a network member: a computer or a phone. */
  kind?: 'desktop' | 'phone';
  state: AnnexDeviceState;
  /** ISO time it was paired; empty when unknown. */
  pairedAt: string;
  /** ISO time of its last connection; empty when unknown. */
  lastSeen: string;
  /** Paired for this session only (a phone's session pairing): forgotten when Annex stops. */
  sessionOnly?: boolean;
  /** For a device this machine connects to: the address in use or tried last, as `host:port`. */
  address?: string;
  /** For a device this machine connects to: the host name or address the person typed, if any. */
  typedHost?: string;
  /** Why it isn't connected, and what to do, when that's known. */
  problem: AnnexProblem | null;
  /**
   * For a network member: where its join, or its removal, is confirmed (#3061).
   * Names of members whose view shows it, and of those it hasn't reached yet.
   * Absent once every member has it.
   */
  confirmation?: { kind: 'join' | 'removal'; confirmedBy: string[]; waitingOn: string[] };
}

/** A device this machine has heard from on the Annex Network channel (#3060). */
export interface AnnexNetworkMemberListing {
  fingerprint: string;
  name: string;
  kind: 'desktop' | 'phone';
  /** Its channel to or from this machine is open now. */
  connected: boolean;
  /** How many members it says the network has, itself included. */
  memberCount: number;
  /** ISO time of its last message. */
  lastHeard: string;
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
  /** This connection's satellite can't build a snapshot yet, and is retrying. */
  snapshotUnavailable?: boolean;
  /** The pairing can't be used (older version, removed on the other side, or expired certificate). Pair again to connect. */
  needsPairing?: boolean;
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
  /** The machine this snapshot is from (#3063): its agents' addresses are `<agentId>@<fingerprint>`. */
  machine?: { fingerprint: string; name: string };
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
  /**
   * The oldest OS version this artifact runs on, compared part by part with
   * `process.getSystemVersion()`: macOS `13.0`; Windows `10.0.<build>`, since
   * Windows 11 still reports 10.0. A client below it skips the update (#2924).
   * Absent means no limit.
   */
  minSystemVersion?: string;
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
  /** Why the last finished check failed, or null when it succeeded. */
  lastCheckError: string | null;
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
  | 'cyberpunk'
  // Designed around their gradients (#2916), in src/renderer/themes/gradient-themes.ts.
  | 'aurora'
  | 'canyon'
  | 'daybreak'
  | 'mist'
  // The seven Workshop packs (#2753), in src/renderer/themes/packs.
| 'maple'
| 'harvest'
| 'pumpkin-spice'
| 'amber-forest'
| 'twilight-ember'
| 'frost'
| 'evergreen'
| 'northern-lights'
| 'snowfall'
| 'polar-night'
| 'cherry-blossom'
| 'spring-meadow'
| 'wisteria'
| 'daffodil'
| 'moonlit-garden'
| 'sunset-beach'
| 'ocean-breeze'
| 'tropical'
| 'golden-hour'
| 'midnight-swim'
| 'coral-reef'
| 'tide-pool'
| 'pacific'
| 'deep-sea'
| 'abyssal'
| 'redmond'
| 'mountain-view'
| 'cupertino'
| 'ai-lab'
| 'seattle'
| 'neon-cyberpunk'
| 'synthwave'
| 'neon-tokyo'
| 'electric'
| 'vaporwave';

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
  /** The collection a built-in theme came in, such as `Winter` (#2753). Unset for the original built-ins. */
  collection?: string;
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
  /** The folder's name. */
  name: string;
  path: string;
  hasReadme: boolean;
  /** The `name` in SKILL.md's front matter, when it has one: what a provider reports (#2929). */
  skillName?: string;
  /** Clubhouse delivered this folder for a managed agent (its skills manifest names it). */
  managed?: boolean;
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
  /** The level to start at (#2761); wins over `freeAgentMode` and `permissionMode`. */
  access?: import('./agent-access').AccessLevel;
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
  /** Clubhouse-managed quick agents (#2893): start from this template, with this launch's part changes (#2928). */
  managedTemplate?: QuickTemplateChoice;
}

/** At most this many parts added, and this many removed, for one quick launch (#2928). */
export const MAX_QUICK_RUN_CHANGES = 50;

/**
 * A quick agent's template (#2893, D25), and what this one launch adds to it or
 * leaves out (#2928, D102). Part ids; the template itself never changes.
 */
export interface QuickTemplateChoice {
  id: string;
  agentName: string;
  addParts?: string[];
  removeParts?: string[];
}

/** What one quick launch changed from its template (#2928): part ids, for Details and Retry. */
export interface QuickRunChanges {
  added: string[];
  removed: string[];
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
   * and the delete dialog blocks deleting it (#2245).
   */
  checkError?: string;
  /**
   * The worktree folder is gone. The agent's branch was checked from the
   * project instead, so `unpushedCommits` are the ones deleting it would lose.
   */
  worktreeMissing?: boolean;
}

/** Settings' Clear all for disposed helpers (#3186): rows already gone count as neither. */
export interface RemoveDisposedManyResult {
  removed: number;
  failed: Array<{ agentId: string; message: string }>;
}

export interface DeleteResult {
  ok: boolean;
  message: string;
}

/** How a durable agent is deleted: what happens to its worktree and branch. */
export type AgentDeleteMode = 'commit-push' | 'cleanup-branch' | 'save-patch' | 'force' | 'unregister';

/** The result of deleting a durable agent with its helpers (#3182). */
export interface AgentDeleteResult extends DeleteResult {
  /** The agent was deleted (or removed from the list, for unregister). */
  deleted?: boolean;
  /** It has live helpers and no choice was given. Nothing changed. */
  needsHelperChoice?: { helpers: Array<{ id: string; name: string }> };
  /** What settling the helpers did, when it ran. */
  helpers?: HelperCascadeResult;
  /** The worktree check that refused the delete. Nothing changed. */
  worktree?: WorktreeStatus;
  /** Quick agents that were running in its worktree and were stopped. */
  stoppedQuickAgents?: string[];
  /** The agent couldn't be stopped, so nothing of it was deleted. Helpers may have been settled. */
  stopFailed?: 'stop_failed' | 'agent_still_running';
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
  /** Access (#2761); `freeAgentMode` is the legacy field derived from it. */
  access?: import('./agent-access').AccessLevel;
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

export type UpdateAgentAction = 'interrupt' | 'kill';
export const UPDATE_AGENT_ACTION_TIMEOUT_MS = 10_000;

export type UpdateAgentActionResult =
  | { status: 'resolved'; isWorking: boolean }
  | { status: 'timeout' | 'error'; isWorking: boolean; message: string };

