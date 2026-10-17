/**
 * Telemetry attribute registry: the single allowlist for every attribute key,
 * span name, metric name and event name Clubhouse may export.
 *
 * Instrumentation code sets attributes only through `ATTR.x(value)`. The
 * main-process redaction pipeline (src/main/telemetry/redaction.ts) re-checks
 * every exported item against this file and drops anything not declared here.
 * See docs/telemetry-otel-spec.md §5.
 *
 * This module has no runtime dependencies so the renderer can share it later.
 */

/** Bump on breaking attribute changes; exported as `clubhouse.telemetry.schema`. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Maximum length of any exported string attribute (spec §5.1). */
export const MAX_STRING_LENGTH = 128;

/** Value used when an enum attribute receives something outside its set. */
export const OTHER = 'other';

export type TelemetryLevel = 'errors' | 'standard' | 'detailed';
export const TELEMETRY_LEVELS: readonly TelemetryLevel[] = ['errors', 'standard', 'detailed'];

/** True when an item tagged `itemLevel` should be emitted at the configured level. */
export function levelAllows(configured: TelemetryLevel, itemLevel: TelemetryLevel): boolean {
  return TELEMETRY_LEVELS.indexOf(itemLevel) <= TELEMETRY_LEVELS.indexOf(configured);
}

export type AttrKind = 'enum' | 'int' | 'bool' | 'hash' | 'version';

export interface AttrSpec {
  readonly key: string;
  readonly kind: AttrKind;
  readonly values?: readonly string[];
}

/**
 * One typed attribute, produced only by the `ATTR` helpers. `hash` attributes
 * carry the raw opaque id; the main-process facade replaces it with the
 * salted HMAC before anything reaches the SDK.
 */
export interface TelAttr {
  readonly key: string;
  readonly kind: AttrKind;
  readonly value: string | number | boolean;
}

const specs = new Map<string, AttrSpec>();

function register(spec: AttrSpec): void {
  if (specs.has(spec.key)) throw new Error(`Duplicate telemetry attribute key: ${spec.key}`);
  specs.set(spec.key, spec);
}

export function enumAttr<const V extends readonly string[]>(key: string, values: V) {
  register({ key, kind: 'enum', values });
  const allowed = new Set<string>(values);
  return (value: V[number]): TelAttr => ({
    key,
    kind: 'enum',
    value: allowed.has(value) ? value : OTHER,
  });
}

export function intAttr(key: string) {
  register({ key, kind: 'int' });
  return (value: number): TelAttr => ({ key, kind: 'int', value: Math.trunc(value) });
}

export function boolAttr(key: string) {
  register({ key, kind: 'bool' });
  return (value: boolean): TelAttr => ({ key, kind: 'bool', value: value === true });
}

/** An opaque internal id (agent id, project id, run id). Never a name or path. */
export function hashAttr(key: string) {
  register({ key, kind: 'hash' });
  return (rawId: string): TelAttr => ({ key, kind: 'hash', value: rawId });
}

/** A release version string such as `0.43.1` or `0.43.0-beta.2`. */
export function versionAttr(key: string) {
  register({ key, kind: 'version' });
  return (value: string): TelAttr => ({ key, kind: 'version', value });
}

// --- Closed enums -----------------------------------------------------------

/** Union of every flow's closed `error.type` enum (spec §4). Phase 1 subset. */
export const ERROR_TYPES = [
  'exporter_failed',
  'init_failed',
  'timeout',
  'unknown',
  // Startup (§4.1)
  'settings_load_failed',
  'plugin_system_failed',
  'window_load_failed',
  'ipc_register_failed',
  // Agents (§4.4)
  'binary_not_found',
  // Renderer and crash handling (§4.2, Phase 3)
  'render_error',
  // Persistence (§12 H1)
  'write_failed',
  // Auto-update (§4.3)
  'network_transient',
  'network',
  'http_4xx',
  'http_5xx',
  'manifest_invalid',
  'manifests_unavailable',
  'integrity_mismatch',
  'redirect_blocked',
  'apply_spawn_failed',
  'apply_failed',
  // Chat turns (§4.4 chat turns): chat's closed ChatErrorCode set (src/shared/chat/events.ts)
  'max_tokens',
  'refusal',
  'rpc_timeout',
  'process_exited',
  'spawn_failed',
  'unhandled_server_request',
  'protocol_error',
  'driver_stream_failed',
  'auth_required',
  'rate_limited',
  'context_overflow',
  'tool_failed',
  // Agents (§4.4, Phase 4)
  'mcp_tool_error',
  'mcp_tool_threw',
] as const;

export const OUTCOMES = ['ok', 'error', 'cancelled', 'timeout', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// --- The registry -----------------------------------------------------------

export const ATTR = {
  // Cross-cutting (§3.2)
  outcome: enumAttr('clubhouse.outcome', OUTCOMES),
  errorType: enumAttr('error.type', ERROR_TYPES),
  process: enumAttr('clubhouse.process', ['main', 'renderer']),

  // App lifecycle (§4.1)
  startupKind: enumAttr('clubhouse.startup.kind', ['cold', 'after_update', 'safe_mode']),

  // Telemetry self-observation (§4.15)
  telemetrySignal: enumAttr('clubhouse.telemetry.signal', ['traces', 'metrics', 'logs']),
  httpClass: enumAttr('clubhouse.http.class', ['2xx', '3xx', '4xx', '5xx', 'network', 'timeout']),
  telemetryDestination: enumAttr('clubhouse.telemetry.destination', ['azure', 'otlp']),

  // Agents (§5.1 examples; instrumented from Phase 3)
  agentKind: enumAttr('clubhouse.agent.kind', ['durable', 'quick', 'companion']),
  orchestrator: enumAttr('clubhouse.orchestrator', ['claude-code', 'codex-cli', 'copilot-cli', 'other']),
  agentRuntime: enumAttr('clubhouse.agent.runtime', ['pty', 'headless', 'chat']),
  exitCode: intAttr('process.exit.code'),
  agentIdHash: hashAttr('clubhouse.agent.id_hash'),
  sizeBucket: enumAttr('clubhouse.size_bucket', ['0', '<1KB', '<100KB', '<1MB', '<10MB', '<100MB', '>=100MB']),

  // Exceptions (§4.2): the error class name only, never the message.
  exceptionHandled: boolAttr('clubhouse.exception.handled'),
  exceptionOrigin: enumAttr('clubhouse.exception.origin', ['main', 'renderer', 'plugin']),

  // Versions (§4.3)
  updateFromVersion: versionAttr('clubhouse.update.from_version'),

  // Renderer foundation and crash handling (§4.2, §4.15; Phase 3)
  windowKind: enumAttr('clubhouse.window.kind', ['main', 'popout']),
  /**
   * The active main view (spec §4.15), a coarse bounded enum. The chrome
   * refresh sets it from the active tab and pane (spec §9.1; chrome spec §8);
   * finer placement goes in a separate attribute, not here.
   */
  view: enumAttr('clubhouse.view', ['agent', 'terminal', 'canvas', 'files', 'git', 'settings', 'plugin', 'other']),
  errorBoundary: enumAttr('clubhouse.error.boundary', ['app', 'plugin']),
  /** Electron `RenderProcessGoneDetails.reason`. */
  rendererGoneReason: enumAttr('clubhouse.renderer.gone_reason', [
    'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction',
  ]),
  /** Electron `Details.type` for `child-process-gone`. */
  childProcessType: enumAttr('clubhouse.child_process.type', [
    'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown',
  ]),
  childProcessGoneReason: enumAttr('clubhouse.child_process.gone_reason', [
    'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction',
  ]),

  // Chrome redesign (docs/chrome-redesign-spec.md §8). Bounded: plugin-owned
  // lists report `sidebar_list`, plugin ids are never values.
  /** Where in the new chrome the user is, beside the coarse `clubhouse.view`. */
  uiSurface: enumAttr('clubhouse.ui.surface', [
    'sidebar_agents', 'sidebar_list', 'sidebar_settings', 'start_page', 'first_run', 'host_menu', 'more_menu', 'hover_card', 'row_menu',
  ]),
  /** Feature-usage events from the new chrome. */
  uiFeature: enumAttr('clubhouse.ui.feature', [
    'sidebar_toggle', 'sidebar_resize', 'tab_select', 'project_select', 'agent_select', 'app_item_open',
    'needs_you_select', 'project_collapse', 'project_collapse_all', 'project_pin', 'project_reorder',
    'fold_toggle', 'completed_dismiss', 'completed_clear', 'new_agent_open', 'search_open',
  ]),
  /** The UI action whose failure was caught and reported (`clubhouse.ui.action_failed`). */
  uiAction: enumAttr('clubhouse.ui.action', [
    'add_project', 'reorder_projects', 'chrome_state_save', 'tab_order_save', 'agent_create',
  ]),
  // App lifecycle (§4.1, Phase 3b)
  shutdownStep: enumAttr('clubhouse.shutdown.step', [
    'pty_kill_all', 'agent_config_flush', 'group_project_flush', 'bulletin_flush', 'update_apply_on_quit',
  ]),
  previousExit: enumAttr('clubhouse.shutdown.previous', ['unknown_exit', 'crash_loop']),
  safeModeTrigger: enumAttr('clubhouse.safe_mode.trigger', ['cli_flag', 'user_chosen', 'user_declined']),
  /** How this copy was installed (§12 H6). Detected asynchronously; never blocks startup. */
  installKind: enumAttr('clubhouse.install.kind', ['mac_zip', 'squirrel', 'deb', 'rpm', 'appimage', 'linux_other', 'dev']),

  // Config snapshot (§5.4): counts and switches only, never names.
  projectsCount: intAttr('clubhouse.projects.count'),
  themeKind: enumAttr('clubhouse.theme.kind', ['builtin', 'plugin']),
  clubhouseMode: boolAttr('clubhouse.clubhouse_mode'),
  annexServer: boolAttr('clubhouse.annex.server'),
  annexClient: boolAttr('clubhouse.annex.client'),
  loggingEnabled: boolAttr('clubhouse.logging.enabled'),

  // Auto-update (§4.3)
  updateTrigger: enumAttr('clubhouse.update.trigger', ['startup', 'periodic', 'manual']),
  updateChannel: enumAttr('clubhouse.update.channel', ['stable', 'preview']),
  updateResult: enumAttr('clubhouse.update.result', [
    'up_to_date', 'available', 'dismissed', 'no_artifact', 'skipped_busy', 'disabled',
    'downloaded', 'already_downloaded', 'applied', 'failed',
  ]),
  updatePhase: enumAttr('clubhouse.update.phase', ['check', 'download', 'apply', 'apply_on_quit']),
  updateApplyMode: enumAttr('clubhouse.update.apply.mode', ['relaunch', 'on_quit']),
  applyVerified: enumAttr('clubhouse.update.apply.verified', ['verified', 'not_taken']),

  // Process health (§4.15)
  processType: enumAttr('clubhouse.process.type', ['browser', 'renderer', 'gpu', 'utility', 'other']),

  // Persistence integrity (§12 H1, Phase 3c)
  persistStore: enumAttr('clubhouse.persist.store', [
    'settings', 'agents', 'projects', 'plugin_kv', 'canvas', 'group_registry', 'bulletin',
  ]),
  persistResult: enumAttr('clubhouse.persist.result', ['ok', 'failed']),
  persistAction: enumAttr('clubhouse.persist.action', [
    'primary_corrupt', 'quarantined', 'restored_from_backup', 'backup_corrupt', 'reset_to_default',
    'external_change_merged', 'records_dropped', 'unreadable',
  ]),
  persistGuardReason: enumAttr('clubhouse.persist.guard_reason', ['not_hydrated', 'verify_empty']),

  // Chat (§4.4 chat turns, §9.1): mapped from the chat event bus. Numbers and
  // closed enums only; never message text, tool inputs or paths.
  /** The chat transport, from the driver's `session_started` (research §7). */
  chatDriver: enumAttr('clubhouse.chat.driver', [
    'claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_acp', 'copilot_sdk', 'acp',
  ]),
  turnEndReason: enumAttr('clubhouse.turn.end_reason', ['complete', 'error', 'cancelled', 'timeout']),
  turnToolCalls: intAttr('clubhouse.turn.tool_calls'),
  /** Attributes are integers, so the span carries milliseconds; the histogram is in seconds. */
  turnTimeToFirstTokenMs: intAttr('clubhouse.turn.time_to_first_token_ms'),
  genAiInputTokens: intAttr('gen_ai.usage.input_tokens'),
  genAiOutputTokens: intAttr('gen_ai.usage.output_tokens'),
  genAiTokenType: enumAttr('gen_ai.token.type', ['input', 'output']),
  /** The cost is an API-price estimate (e.g. Claude on a subscription), not a bill. */
  costEstimate: boolAttr('clubhouse.cost.estimate'),
  /** What kind of native message a driver didn't recognize (protocol drift, §12 H2). */
  chatProtocolKind: enumAttr('clubhouse.chat.protocol.kind', ['request', 'notification', 'field']),
  permissionPath: enumAttr('clubhouse.permission.path', ['hook', 'chat']),
  permissionSource: enumAttr('clubhouse.permission.source', ['desktop', 'annex']),

  // Agents (§4.4, Phase 4)
  agentExitClass: enumAttr('clubhouse.agent.exit.class', [
    'completed', 'failed', 'early_failure', 'killed_user', 'killed_escalated', 'stale_swept', 'replaced',
  ]),
  killStage: enumAttr('clubhouse.kill.stage_reached', ['exit_command', 'eof', 'sigterm', 'sigkill']),
  hookKind: enumAttr('clubhouse.hook.kind', [
    'pre_tool', 'post_tool', 'tool_error', 'stop', 'notification', 'permission_request', 'other',
  ]),
  /** Built-in tool names only; MCP tools are bucketed, never named (spec §4.4). */
  toolBucket: enumAttr('clubhouse.tool.bucket', [
    'Bash', 'Edit', 'MultiEdit', 'Write', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task',
    'TodoWrite', 'NotebookEdit', 'shell', 'apply_patch', 'mcp_clubhouse', 'mcp_other', 'other',
  ]),
  toolResult: enumAttr('clubhouse.tool.result', ['ok', 'error']),
  permissionDecision: enumAttr('clubhouse.permission.decision', ['allow', 'deny', 'ask']),
  permissionResult: enumAttr('clubhouse.permission.result', ['resolved', 'timeout']),
  mcpToolKind: enumAttr('clubhouse.mcp.tool_kind', ['clubhouse', 'browser', 'terminal', 'group', 'plugin', 'global', 'other']),
  /**
   * The Clubhouse tool suffix (or global tool name) from this fixed list;
   * anything else, and every plugin tool, is `other`. A test keeps it in sync
   * with the tools registered under clubhouse-mcp/tools.
   */
  mcpTool: enumAttr('clubhouse.mcp.tool', [
    // agent
    'send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file', 'clear_agent', 'compact_agent',
    // browser
    'navigate', 'screenshot', 'get_console', 'click', 'type', 'evaluate', 'get_page_content', 'get_accessibility_tree',
    // group project
    'list_members', 'post_bulletin', 'read_bulletin', 'read_topic', 'read_message', 'get_project_info',
    'set_project_info', 'shoulder_tap', 'broadcast', 'wake_agent', 'sleep_agent', 'toggle_polling', 'query_polling',
    'nudge_polling', 'clear_topic', 'delete_messages',
    // global
    'notify_user',
    'other',
  ]),
  mcpResult: enumAttr('clubhouse.mcp.result', ['ok', 'tool_error', 'threw']),
  binaryLookupTier: enumAttr('clubhouse.binary.lookup_tier', ['cache', 'well_known', 'path_scan', 'login_shell', 'not_found']),
} as const;

/**
 * Keys the SDK itself writes that the redaction pipeline must keep. They are
 * set by our own code paths (exception events, sampler), never by callers.
 */
export const SDK_ATTRIBUTE_KEYS = {
  exceptionType: 'exception.type',
  exceptionStacktrace: 'exception.stacktrace',
  /** Always set to the exception type: App Insights requires a message, we never send the real one. */
  exceptionMessage: 'exception.message',
  sampleRate: 'microsoft.sample_rate',
  /** Routes an event log record to the App Insights `customEvents` table. */
  customEventName: 'microsoft.custom_event.name',
  /**
   * The install id, copied onto every span and log record (never metrics):
   * the Azure exporter fills `user_Id` from item attributes, not the resource.
   */
  endUserPseudoId: 'enduser.pseudo.id',
} as const;

/** Stack traces get a larger cap than other strings; frames are pre-sanitized. */
export const MAX_STACKTRACE_LENGTH = 4096;

export function getAttributeSpec(key: string): AttrSpec | undefined {
  return specs.get(key);
}

export function allAttributeKeys(): string[] {
  return [...specs.keys()].sort();
}

// --- Names ------------------------------------------------------------------

export interface SpanDef {
  readonly level: TelemetryLevel;
  /** Root user-flow spans export as SERVER so they land in App Insights `requests`. */
  readonly root: boolean;
}

export const SPANS = {
  'clubhouse.telemetry.test': { level: 'errors', root: true },
  /** A window that stopped responding, from `unresponsive` to `responsive` (§4.2). */
  'clubhouse.renderer.unresponsive': { level: 'errors', root: true },
  // Startup tree (§4.1): process start → renderer-ready.
  'clubhouse.app.startup': { level: 'standard', root: true },
  'clubhouse.app.startup.main_ready': { level: 'standard', root: false },
  'clubhouse.app.startup.register_ipc': { level: 'standard', root: false },
  'clubhouse.app.startup.create_window': { level: 'standard', root: false },
  'clubhouse.app.startup.renderer_init': { level: 'standard', root: false },
  'clubhouse.app.startup.load_settings': { level: 'standard', root: false },
  'clubhouse.app.startup.plugin_system': { level: 'standard', root: false },
  // Shutdown (§4.1): before-quit → quit, one child per cleanup.
  'clubhouse.app.shutdown': { level: 'standard', root: true },
  'clubhouse.app.shutdown.step': { level: 'standard', root: false },
  // Auto-update (§4.3)
  'clubhouse.update.check': { level: 'standard', root: true },
  'clubhouse.update.download': { level: 'standard', root: true },
  'clubhouse.update.apply': { level: 'standard', root: true },
  // Chat (§4.4 chat turns)
  /** One chat turn, turn_started to turn_ended on the chat bus. */
  'clubhouse.agent.turn': { level: 'standard', root: true },
  // Agents (§4.4, Phase 4)
  /** One agent process, spawn to exit (PTY or headless). Exported when it ends. */
  'clubhouse.agent.run': { level: 'standard', root: true },
  /** A permission request on the hook path, request to decision. */
  'clubhouse.agent.permission': { level: 'standard', root: true },
  /** One Clubhouse MCP tool call served to an agent. */
  'clubhouse.mcp.tool_call': { level: 'standard', root: true },
} as const satisfies Record<string, SpanDef>;
export type SpanName = keyof typeof SPANS;

/**
 * The flow that was running when the main thread stalled (§4.15). Values are
 * the span names themselves (static strings), plus `none`.
 */
export const blockedFlowAttr = enumAttr('clubhouse.blocked.flow', [...(Object.keys(SPANS) as SpanName[]), 'none']);

export interface MetricDef {
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly unit?: string;
  readonly level: TelemetryLevel;
  readonly description: string;
  /** Attribute keys allowed as dimensions. Hash attributes are never allowed. */
  readonly attributes: readonly string[];
}

export const METRICS = {
  'clubhouse.app.sessions': {
    kind: 'counter',
    unit: '{session}',
    level: 'errors',
    description: 'App sessions started',
    attributes: ['clubhouse.startup.kind'],
  },
  'clubhouse.telemetry.dropped': {
    kind: 'counter',
    unit: '{item}',
    level: 'errors',
    description: 'Telemetry items dropped by the per-session cap or the redaction pipeline',
    attributes: ['clubhouse.telemetry.signal'],
  },
  'clubhouse.renderer.long_frames': {
    kind: 'counter',
    unit: '{frame}',
    level: 'standard',
    description: 'Long animation frames (>= 50 ms) in a renderer, aggregated per minute',
    attributes: ['clubhouse.view', 'clubhouse.window.kind', 'clubhouse.ui.surface'],
  },
  'clubhouse.renderer.long_frame.duration': {
    kind: 'histogram',
    unit: 's',
    level: 'standard',
    description: 'Duration of sampled long animation frames',
    attributes: ['clubhouse.view', 'clubhouse.window.kind', 'clubhouse.ui.surface'],
  },
  'clubhouse.renderer.unresponsive_count': {
    kind: 'counter',
    unit: '{event}',
    level: 'errors',
    description: 'Windows that stopped responding',
    attributes: ['clubhouse.window.kind'],
  },
  'clubhouse.app.startup.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Process start to renderer ready',
    attributes: ['clubhouse.startup.kind'],
  },
  'clubhouse.app.session.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'App session length, recorded at shutdown',
    attributes: [],
  },
  'clubhouse.app.shutdown.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'before-quit to quit',
    attributes: [],
  },
  'clubhouse.app.unclean_exits': {
    kind: 'counter', unit: '{exit}', level: 'errors',
    description: 'Previous sessions that ended without a clean shutdown, counted at the next start',
    attributes: ['clubhouse.shutdown.previous'],
  },
  'clubhouse.update.checks': {
    kind: 'counter', unit: '{check}', level: 'standard',
    description: 'Update checks by result',
    attributes: ['clubhouse.update.result', 'clubhouse.update.channel', 'clubhouse.update.trigger'],
  },
  'clubhouse.update.failures': {
    kind: 'counter', unit: '{failure}', level: 'errors',
    description: 'Update failures by phase and error type',
    attributes: ['clubhouse.update.phase', 'error.type'],
  },
  'clubhouse.update.download.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Update artifact download time',
    attributes: [],
  },
  'clubhouse.process.eventloop.delay.p99': {
    kind: 'gauge', unit: 's', level: 'standard',
    description: 'Main-process event-loop delay, 99th percentile over the last minute',
    attributes: [],
  },
  'clubhouse.process.eventloop.delay.max': {
    kind: 'gauge', unit: 's', level: 'standard',
    description: 'Main-process event-loop delay, maximum over the last minute',
    attributes: [],
  },
  'clubhouse.process.memory': {
    kind: 'gauge', unit: 'By', level: 'standard',
    description: 'Working-set memory summed per Electron process type',
    attributes: ['clubhouse.process.type'],
  },
  'clubhouse.process.cpu': {
    kind: 'gauge', unit: '%', level: 'standard',
    description: 'CPU usage summed per Electron process type',
    attributes: ['clubhouse.process.type'],
  },
  'clubhouse.persist.writes': {
    kind: 'counter', unit: '{write}', level: 'standard',
    description: 'Writes to Clubhouse JSON stores by store and result',
    attributes: ['clubhouse.persist.store', 'clubhouse.persist.result'],
  },
  'clubhouse.persist.write.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Time to write one store file',
    attributes: ['clubhouse.persist.store'],
  },
  'clubhouse.persist.guard_blocks': {
    kind: 'counter', unit: '{save}', level: 'errors',
    description: 'Saves skipped by a data-loss guard (e.g. canvas after a failed load)',
    attributes: ['clubhouse.persist.store', 'clubhouse.persist.guard_reason'],
  },
  'clubhouse.persist.flush_barrier.wait': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Time a flush waited on an in-flight write before writing newer state',
    attributes: ['clubhouse.persist.store'],
  },
  // Chat (§4.4 chat turns, §12 H2)
  'clubhouse.agent.turn.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Chat turn length, turn_started to turn_ended',
    attributes: ['clubhouse.chat.driver', 'clubhouse.orchestrator', 'clubhouse.turn.end_reason'],
  },
  'clubhouse.agent.turn.time_to_first_token': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Chat turn start to the first streamed reply or thinking text',
    attributes: ['clubhouse.chat.driver'],
  },
  'clubhouse.agent.tokens': {
    kind: 'counter', unit: '{token}', level: 'standard',
    description: 'Tokens used by chat turns, by type',
    attributes: ['clubhouse.chat.driver', 'clubhouse.orchestrator', 'gen_ai.token.type'],
  },
  'clubhouse.agent.cost': {
    kind: 'counter', unit: 'USD', level: 'standard',
    description: 'Cost of chat turns where the provider reports one (estimates flagged)',
    attributes: ['clubhouse.chat.driver', 'clubhouse.orchestrator', 'clubhouse.cost.estimate'],
  },
  'clubhouse.chat.protocol.unknown': {
    kind: 'counter', unit: '{message}', level: 'errors',
    description: 'Native protocol messages, items or fields a chat driver did not recognize (CLI drift)',
    attributes: ['clubhouse.chat.driver', 'clubhouse.chat.protocol.kind'],
  },
  'clubhouse.agent.turn.stalled': {
    kind: 'counter', unit: '{turn}', level: 'errors',
    description: 'Chat turns with no event for 5 minutes while not waiting on the user',
    attributes: ['clubhouse.chat.driver'],
  },
  'clubhouse.agent.runs': {
    kind: 'counter', unit: '{run}', level: 'standard',
    description: 'Agent runs that ended, by runtime, orchestrator and exit class',
    attributes: ['clubhouse.agent.runtime', 'clubhouse.orchestrator', 'clubhouse.agent.exit.class'],
  },
  'clubhouse.agent.run.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Agent run length, spawn to exit',
    attributes: ['clubhouse.agent.runtime', 'clubhouse.orchestrator', 'clubhouse.agent.exit.class'],
  },
  'clubhouse.agent.time_to_shell_ready': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'PTY spawn to the shell accepting the agent command',
    attributes: ['clubhouse.orchestrator'],
  },
  'clubhouse.agent.time_to_first_output': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Spawn to the first agent output',
    attributes: ['clubhouse.agent.runtime', 'clubhouse.orchestrator'],
  },
  'clubhouse.pty.output.bytes': {
    kind: 'counter', unit: 'By', level: 'standard',
    description: 'Agent output volume, added once per run at exit (never per chunk)',
    attributes: ['clubhouse.agent.runtime', 'clubhouse.orchestrator'],
  },
  'clubhouse.agent.kill.escalations': {
    kind: 'counter', unit: '{kill}', level: 'standard',
    description: 'Graceful kills that had to escalate past the exit command',
    attributes: ['clubhouse.kill.stage_reached'],
  },
  'clubhouse.agent.hook_events': {
    kind: 'counter', unit: '{event}', level: 'standard',
    description: 'Hook events received from agent CLIs',
    attributes: ['clubhouse.orchestrator', 'clubhouse.hook.kind'],
  },
  'clubhouse.agent.tool_calls': {
    kind: 'counter', unit: '{call}', level: 'standard',
    description: 'Agent tool calls by built-in tool bucket and result',
    attributes: ['clubhouse.orchestrator', 'clubhouse.tool.bucket', 'clubhouse.tool.result'],
  },
  'clubhouse.agent.permission.wait': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Time a permission request waited for a decision',
    attributes: ['clubhouse.permission.decision', 'clubhouse.permission.result', 'clubhouse.permission.path'],
  },
  'clubhouse.mcp.tool_calls': {
    kind: 'counter', unit: '{call}', level: 'standard',
    description: 'Clubhouse MCP tool calls by tool and result',
    attributes: ['clubhouse.mcp.tool_kind', 'clubhouse.mcp.tool', 'clubhouse.mcp.result'],
  },
  'clubhouse.mcp.tool_call.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Clubhouse MCP tool call latency',
    attributes: ['clubhouse.mcp.tool_kind'],
  },
  'clubhouse.provider.binary_lookup.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Time to resolve an agent CLI binary, by lookup tier (login_shell blocks the main thread)',
    attributes: ['clubhouse.binary.lookup_tier'],
  },
  'clubhouse.telemetry.export.failures': {
    kind: 'counter',
    unit: '{export}',
    level: 'errors',
    description: 'Failed exporter batches',
    attributes: ['clubhouse.telemetry.signal', 'clubhouse.http.class'],
  },
} as const satisfies Record<string, MetricDef>;
export type MetricName = keyof typeof METRICS;

export interface EventDef {
  readonly level: TelemetryLevel;
}

export const EVENTS = {
  'clubhouse.telemetry.test': { level: 'errors' },
  'clubhouse.telemetry.enabled': { level: 'errors' },
  'clubhouse.telemetry.disabled': { level: 'errors' },
  /** Exception records (§4.2). Body is always this name; never the message. */
  'clubhouse.exception': { level: 'errors' },
  /** A renderer process exited (`render-process-gone`). */
  'clubhouse.renderer.gone': { level: 'errors' },
  /** A GPU or utility process exited (`child-process-gone`). */
  'clubhouse.child_process.gone': { level: 'errors' },
  /** A renderer catch site swallowed or toasted an error (spec §12.4). Attributes: `clubhouse.ui.action`, `error.type`. */
  'clubhouse.ui.action_failed': { level: 'errors' },
  /** A chrome feature was used. Attributes: `clubhouse.ui.feature`, `clubhouse.ui.surface`. */
  'clubhouse.ui.feature_used': { level: 'standard' },
  /** The previous session ended without a clean shutdown (§4.1). */
  'clubhouse.app.unclean_exit': { level: 'errors' },
  /** Safe-mode decision at startup (§4.1). */
  'clubhouse.app.safe_mode': { level: 'errors' },
  /** Counts and switches describing this install (§5.4). Once per start, at most daily. */
  'clubhouse.app.config_snapshot': { level: 'standard' },
  /** The main thread stalled for over 2 s; names the flow that was running (§4.15). */
  'clubhouse.process.eventloop_blocked': { level: 'errors' },
  /** At startup: whether the last applied update actually took (§12 H6). */
  'clubhouse.update.apply_verified': { level: 'errors' },
  /** A store hit corruption or fell back to a backup (§12 H1). Silent today; always worth knowing. */
  'clubhouse.persist.recovery': { level: 'errors' },
  /** A data-loss guard blocked saves. Sent once per store and reason per session. */
  'clubhouse.persist.guard_blocked': { level: 'errors' },
} as const satisfies Record<string, EventDef>;
export type EventName = keyof typeof EVENTS;

export function isKnownSpan(name: string): name is SpanName {
  return Object.prototype.hasOwnProperty.call(SPANS, name);
}

export function isKnownMetric(name: string): name is MetricName {
  return Object.prototype.hasOwnProperty.call(METRICS, name);
}

export function isKnownEvent(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENTS, name);
}
