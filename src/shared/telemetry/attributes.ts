/**
 * Telemetry attribute registry: the single allowlist for every attribute key,
 * span name, metric name and event name Clubhouse may export.
 *
 * Instrumentation code sets attributes only through `ATTR.x(value)`. The
 * main-process redaction pipeline (src/main/telemetry/redaction.ts) re-checks
 * every exported item against this file and drops anything not declared here.
 * See docs/telemetry-otel-spec.md §5.
 *
 * Its only import is the IPC channel constants (themselves dependency-free),
 * so the renderer can share it.
 */

import { IPC } from '../ipc-channels';

/** Bump on breaking attribute changes; exported as `clubhouse.telemetry.schema`. */
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../marketplace-types';
import type { BuiltinThemeId } from '../types';
import { ACTION_EVENT_KINDS, ACTION_STEP_KINDS, MISSED_RUN_RULES } from '../actions/types';
import { GRANT_ACTIONS } from '../agent-grants';
import { DISPATCHER_USAGE_KINDS } from '../dispatcher-usage';
import {
  DECISION_QUOTA_QUALITIES,
  DECISION_SCORE_BASES,
  DECISION_TIE_REASONS,
  HELPER_COOLDOWN_KINDS,
  HELPER_DECISION_OUTCOMES,
  HELPER_REUSE_KINDS,
  HELPER_RUN_OUTCOMES,
  HELPER_SPAWN_RESULTS,
  HELPER_TASK_PROFILES,
  MAPPING_KINDS,
  USAGE_BASELINES,
  USAGE_COMPLETENESS,
  USAGE_DEDUPS,
  USAGE_SAMPLE_KINDS,
  USAGE_SCOPES,
  USAGE_SOURCES,
} from './helper-usage-contract';

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

export type AttrKind = 'enum' | 'int' | 'bool' | 'hash' | 'version' | 'uuid';

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

/** Ephemeral random correlation identity. Main process revalidates UUID v4. Never hardware/account IDs. */
export function uuidAttr(key: string) {
  register({ key, kind: 'uuid' });
  return (value: string): TelAttr => ({ key, kind: 'uuid', value });
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
  'empty_response',
  'tool_failed',
  // Agents (§4.4, Phase 4)
  'mcp_tool_error',
  'mcp_tool_threw',
  // Agents: create, spawn, delete, shoulder taps (§4.4, Phase 4b)
  'orchestrator_unknown',
  'preflight_failed',
  'cwd_invalid',
  'pty_spawn_failed',
  'headless_no_pid',
  'chat_start_failed',
  'materialize_failed',
  'worktree_failed',
  'delete_failed',
  'tap_undelivered',
  // Workspace (§4.7–4.10, Phase 5)
  'not_a_repo',
  'validation',
  'nonzero_exit',
  'no_remote',
  'conflict',
  'auth',
  'git_init_failed',
  'ENOENT',
  'EACCES',
  'EISDIR',
  'ENOTDIR',
  'EEXIST',
  'EPERM',
  'ENOSPC',
  'EMFILE',
  'path_denied',
  'max_buffer',
  'bad_regex',
  'rg_failed',
  'activation_timeout',
  'module_resolve_failed',
  'invalid_export',
  'activate_threw',
  'base_missing',
  'create_failed',
  'canvas_unreadable',
  'canvas_load_failed',
  // Workspace 5b (§4.11)
  'invalid_json',
  'invalid_id',
  'install_failed',
  'no_update_available',
  // Annex (§4.12, Phase 6)
  'identity_unreachable',
  'identity_invalid',
  'pair_rejected',
  'cert_missing',
  'cert_mismatch',
  'protocol_incompatible',
  'auth_rejected',
  'ws_error',
  'handshake_timeout',
  'not_connected',
  'send_failed',
  // Goobers (§4.13, Phase 6b)
  'goobers_daemon_failed',
] as const;

export const OUTCOMES = ['ok', 'error', 'cancelled', 'timeout', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Coarse buckets for item counts (files, tree nodes, matches, views). */
export const COUNT_BUCKETS = ['0', '1-9', '10-99', '100-999', '1000-9999', '>=10000'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export function countBucket(n: number): CountBucket {
  if (!(n > 0)) return '0';
  if (n < 10) return '1-9';
  if (n < 100) return '10-99';
  if (n < 1000) return '100-999';
  if (n < 10_000) return '1000-9999';
  return '>=10000';
}

/** User-initiated git operations (§4.8), plus the polled status. */
export const GIT_OPS = [
  'checkout', 'stage', 'unstage', 'stage_all', 'unstage_all', 'discard', 'commit', 'push', 'pull',
  'create_branch', 'stash', 'stash_pop', 'diff', 'show_commit', 'worktree_list',
  'head_sha', 'diff_numstat', 'branch_changes', 'branch_patch', 'branch_log', 'pr_info', 'open_pr',
  'status', 'other',
] as const;
export type GitOp = (typeof GIT_OPS)[number];

/**
 * Managed and legacy settings domains (§4.14). The key only, never values;
 * chat runtime settings are left to the chat telemetry mapping (§9.1).
 */
export const SETTINGS_KEYS = [
  'clipboard', 'editor', 'mcp', 'security', 'goobers', 'annex', 'notifications', 'orchestrators', 'headless',
  'free_agent', 'badge', 'update', 'logging', 'sound', 'session', 'experimental', 'marketplace', 'theme', 'chat_idle', 'orchestration',
  'source_control',
] as const;

/** Built-in theme ids (shared/types.ts BuiltinThemeId); plugin themes report `other`. */
export const BUILTIN_THEME_IDS = [
  'catppuccin-mocha', 'catppuccin-latte', 'solarized-dark', 'terminal', 'nord', 'dracula', 'tokyo-night', 'gruvbox-dark', 'cyberpunk',
  // Designed around their gradients (#2916).
  'aurora', 'canyon', 'daybreak', 'mist',
  // The Workshop pack themes (#2753).
  'maple', 'harvest', 'pumpkin-spice', 'amber-forest', 'twilight-ember', 'frost',
  'evergreen', 'northern-lights', 'snowfall', 'polar-night', 'cherry-blossom', 'spring-meadow',
  'wisteria', 'daffodil', 'moonlit-garden', 'sunset-beach', 'ocean-breeze', 'tropical',
  'golden-hour', 'midnight-swim', 'coral-reef', 'tide-pool', 'pacific', 'deep-sea',
  'abyssal', 'redmond', 'mountain-view', 'cupertino', 'ai-lab', 'seattle',
  'neon-cyberpunk', 'synthwave', 'neon-tokyo', 'electric', 'vaporwave',
] as const;

// Every built-in id, and nothing else: a new built-in theme must be added here too.
type SameIds<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const builtinThemeIdsMatch: SameIds<(typeof BUILTIN_THEME_IDS)[number], BuiltinThemeId> = true;
void builtinThemeIdsMatch;

/** Supported plugin API versions, kept in sync with the manifest validator. */
export const PLUGIN_API_VERSION_VALUES: readonly string[] = SUPPORTED_PLUGIN_API_VERSIONS.map(String);

/** Built-in plugins (§4.10): the only plugin ids ever sent raw. */
export const BUILTIN_PLUGIN_IDS = [
  'terminal', 'files', 'browser', 'git', 'canvas', 'review', 'group-project', 'sticky-note', 'goobers',
] as const;

// --- The registry -----------------------------------------------------------

/** Every channel string in the IPC constants (nested groups flattened). */
function ipcChannelNames(): string[] {
  const out = new Set<string>();
  const walk = (o: unknown): void => {
    if (typeof o === 'string') out.add(o);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
  };
  walk(IPC);
  return [...out].sort();
}

/** Framebriar access states (the SDK's FramebriarAccessState). */
export const FEEDBACK_ACCESS_STATES = [
  'disconnected', 'checking', 'connecting', 'connected', 'offline', 'stopped', 'disconnecting',
  'expired', 'access-required', 'connection-uncertain', 'enrollment-response-rejected', 'storage-unavailable', 'migration-required',
] as const;

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
  /** A destination kind. Add new kinds here too (settings-types.ts TelemetryDestinationKind). */
  telemetryDestination: enumAttr('clubhouse.telemetry.destination', ['azure', 'otlp', 'framebriar']),

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
  view: enumAttr('clubhouse.view', ['agent', 'terminal', 'canvas', 'files', 'git', 'changes', 'settings', 'plugin', 'other']),
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
    'sidebar_agents', 'sidebar_list', 'sidebar_settings', 'sidebar_help', 'sidebar_agent_settings', 'start_page', 'first_run', 'host_menu', 'more_menu', 'hover_card', 'row_menu', 'new_agent', 'satellite_start',
  ]),
  /**
   * Which shell this session runs (docs/chrome-redesign-spec.md §8). main/telemetry/resource.ts
   * sets it on the resource for the whole session, so nothing passes it on a signal.
   * Registered so a Workbook query may read it.
   */
  uiChrome: enumAttr('clubhouse.ui.chrome', ['legacy', 'v2']),
  /**
   * The kind of input behind a hang or a measured interaction (#2126). Event
   * Timing names map onto these; never the key or the target.
   */
  uiInteractionType: enumAttr('clubhouse.ui.interaction.type', ['click', 'keydown', 'wheel', 'none']),
  /** Longest frame in a coalesced hang burst, in ms (`clubhouse.ui.hang`). */
  uiHangDurationMs: intAttr('clubhouse.ui.hang.duration_ms'),
  /** Long frames over the hang threshold in the burst. */
  uiHangFrames: intAttr('clubhouse.ui.hang.frames'),
  /** Whose script the long-animation-frame attribution blamed. Never the URL. */
  uiHangScriptSource: enumAttr('clubhouse.ui.hang.script_source', ['app', 'plugin', 'extension', 'none']),
  /** Slowest interaction in a coalesced burst, input to next paint in ms (`clubhouse.ui.slow_interaction`, #2307). */
  uiSlowInteractionDurationMs: intAttr('clubhouse.ui.slow_interaction.duration_ms'),
  /** Interactions over the threshold in the burst. */
  uiSlowInteractionCount: intAttr('clubhouse.ui.slow_interaction.count'),
  /** Feature-usage events from the new chrome. */
  uiFeature: enumAttr('clubhouse.ui.feature', [
    'sidebar_toggle', 'sidebar_resize', 'tab_select', 'project_select', 'agent_select', 'app_item_open',
    'needs_you_select', 'project_collapse', 'project_collapse_all', 'project_pin', 'project_reorder',
    'fold_toggle', 'sleeping_fold_pin', 'completed_dismiss', 'completed_clear', 'new_agent_open', 'search_open',
    'start_page_start', 'completed_open', 'first_run_add', 'first_run_drop',
    'host_switch', 'host_retry', 'host_settings_open', 'needs_you_remote_select',
    'more_menu_open', 'more_menu_pick',
    'row_menu_open', 'hover_card_action',
    'project_menu_open', 'agent_reorder', 'idle_toggle', 'needs_you_review',
    'agent_settings_page', 'agent_shell_toggle', 'sidebar_filter', 'filter_search_everything', 'new_agent_create', 'new_agent_start', 'quick_prompt_start', 'first_run_install',
    'dispatcher_open',
  ]),
  /** The UI action whose failure was caught and reported (`clubhouse.ui.action_failed`). */
  uiAction: enumAttr('clubhouse.ui.action', [
    'add_project', 'reorder_projects', 'chrome_state_save', 'tab_order_save', 'agent_create', 'agent_start', 'shortcut_save', 'reorder_agents',
    'agent_stop', 'agent_wake',
    'agent_settings_save',
    // Pins, marks and activity reaching main (#2458).
    'project_state_sync',
  ]),
  // App lifecycle (§4.1, Phase 3b)
  shutdownStep: enumAttr('clubhouse.shutdown.step', [
    'pty_kill_all', 'agent_config_flush', 'group_project_flush', 'bulletin_flush', 'update_apply_on_quit',
    // The lifecycle coordinator's runtime stops and drains (#2053).
    'spawn_drain', 'chat_stop', 'headless_stop', 'session_capture', 'transcript_flush', 'checkpoint_drain', 'config_restore',
  ]),
  previousExit: enumAttr('clubhouse.shutdown.previous', ['unknown_exit', 'crash_loop']),
  safeModeTrigger: enumAttr('clubhouse.safe_mode.trigger', ['cli_flag', 'user_chosen', 'user_declined']),
  /** How this copy was installed (§12 H6). Detected asynchronously; never blocks startup. */
  installKind: enumAttr('clubhouse.install.kind', ['mac_zip', 'squirrel', 'deb', 'rpm', 'appimage', 'linux_other', 'dev']),

  // Config snapshot (§5.4): counts and switches only, never names.
  projectsCount: intAttr('clubhouse.projects.count'),
  themeKind: enumAttr('clubhouse.theme.kind', ['builtin', 'plugin']),
  annexServer: boolAttr('clubhouse.annex.server'),
  annexClient: boolAttr('clubhouse.annex.client'),
  loggingEnabled: boolAttr('clubhouse.logging.enabled'),

  // Auto-update (§4.3)
  updateTrigger: enumAttr('clubhouse.update.trigger', ['startup', 'periodic', 'manual']),
  updateChannel: enumAttr('clubhouse.update.channel', ['stable', 'preview']),
  updateResult: enumAttr('clubhouse.update.result', [
    'up_to_date', 'available', 'dismissed', 'no_artifact', 'os_too_old', 'skipped_busy', 'disabled',
    'downloaded', 'already_downloaded', 'applied', 'failed',
  ]),
  updatePhase: enumAttr('clubhouse.update.phase', ['check', 'download', 'apply', 'apply_on_quit']),
  updateApplyMode: enumAttr('clubhouse.update.apply.mode', ['relaunch', 'on_quit']),
  applyVerified: enumAttr('clubhouse.update.apply.verified', ['verified', 'not_taken']),

  // Process health (§4.15)
  processType: enumAttr('clubhouse.process.type', ['browser', 'renderer', 'gpu', 'utility', 'other']),

  // Persistence integrity (§12 H1, Phase 3c)
  persistStore: enumAttr('clubhouse.persist.store', [
    'settings', 'agents', 'projects', 'plugin_kv', 'canvas', 'group_registry', 'bulletin', 'asset_catalog',
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
    'claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_sdk',
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
  // Chat start (#2304): how a chat start ended, and why it left its first driver.
  /**
   * `chat` on the first driver, `fallback` in chat on a lower driver,
   * `terminal` opened in the terminal instead, `cancelled` killed or
   * replaced by a newer start, `failed` the start threw.
   */
  chatStartResult: enumAttr('clubhouse.chat.start.result', ['chat', 'fallback', 'terminal', 'cancelled', 'failed']),
  /** Why a driver was skipped or the start ended where it did. A closed set; the message itself goes to diag only. */
  chatStartReason: enumAttr('clubhouse.chat.start.reason', [
    'no_driver', 'binary_missing', 'paused', 'handshake_failed', 'login_required', 'version_below_min',
    'version_known_bad', 'start_failed', 'failed_after_session_start', 'killed', 'superseded', 'error',
  ]),
  /** Where a fallback went: the provider's next driver, or the terminal. */
  chatFallbackTo: enumAttr('clubhouse.chat.fallback.to', ['driver', 'terminal']),
  /** The CLI version policy's verdict; `lookup_failed` when no version could be read this time (#2275). */
  chatCliVersionStatus: enumAttr('clubhouse.chat.cli_version.status', [
    'ok', 'untested', 'below_min', 'known_bad', 'unknown', 'lookup_failed',
  ]),
  chatDriversTried: intAttr('clubhouse.chat.drivers_tried'),
  /** Time spent on driver checks (pause, handshake, version), in milliseconds. */
  chatCheckMs: intAttr('clubhouse.chat.check_ms'),
  /** The driver session start, through any resume, in milliseconds. */
  chatSessionStartMs: intAttr('clubhouse.chat.session_start_ms'),
  /**
   * False when a requested resume opened a fresh native session instead. A
   * false is reliable; a true can be optimistic for Claude, whose session
   * reports the requested id until its init arrives.
   */
  chatResumeHonored: boolAttr('clubhouse.chat.resume_honored'),
  /** A native session load, request to answer or to giving up, in milliseconds, for a driver that times it (#2296). */
  chatResumeLoadMs: intAttr('clubhouse.chat.resume.load_ms'),
  /** The same load, request to its first replayed update, in milliseconds. */
  chatResumeFirstReplyMs: intAttr('clubhouse.chat.resume.first_reply_ms'),

  // Agents (§4.4, Phase 4)
  agentExitClass: enumAttr('clubhouse.agent.exit.class', [
    'completed', 'failed', 'early_failure', 'killed_user', 'killed_escalated', 'stale_swept', 'replaced',
  ]),
  killStage: enumAttr('clubhouse.kill.stage_reached', ['exit_command', 'eof', 'sigterm', 'sigkill']),
  /** Which PTY write path refused an oversized write: `write` (text) or `writeBinary`. */
  ptyWriteKind: enumAttr('clubhouse.pty.write.kind', ['text', 'binary']),
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
   * anything else, and every plugin tool, is `other`. A test registers every
   * Clubhouse MCP tool as the app does and keeps this list in sync (#3200).
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
    // orchestration: hand off and dispose (#2229)
    'hand_off', 'dispose_helper',
    // helpers (#2227)
    'start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent', 'call_wire_tool',
    // helpers in other projects (#2515)
    'list_projects',
    // models per CLI (#2569)
    'list_models',
    // helper questions (#2366)
    'answer_helper_question',
    // the Dispatcher (#2536)
    'list_agents', 'inspect_helper',
    // the Dispatcher's two agents (#3036)
    'start_work', 'read_memory', 'write_memory', 'tell_user',
    // what the Dispatcher can do, from its grants (#3048)
    'list_abilities',
    // search over the Dispatcher's memory and transcripts (#3039)
    'search_memory',
    // agent cards for the Dispatcher (#3041)
    'update_my_card',
    // appearance (#2597)
    'update_project', 'update_agent',
    // adding a project folder (#3239)
    'add_project',
    // settings reads (#2653)
    'list_settings', 'read_settings', 'read_helper_presets', 'set_helper_presets', 'request_grant',
    'list_devices', 'rename_device', 'reconnect_device', 'remove_device', 'start_adding_device',
    'request_app_update',
    'get_delivery', 'get_annex_network_settings', 'update_annex_network_settings',
    // Dispatcher controls: helper settings and links between agents (#2661, #3248)
    'set_orchestrator_helpers', 'connect_orchestrators', 'disconnect_orchestrators', 'list_orchestrator_controls', 'set_connection_tools',
    // orchestration: connection tools (#2230)
    'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents', 'list_connections',
    // actions (#2952), the permission model's action.* (#2921)
    'create_action', 'list_actions', 'update_action', 'delete_action', 'run_action', 'action_history', 'subscribe',
    // provider changes (#2845)
    'preview_provider', 'change_provider',
    // managed agents: parts, setup, templates and restart (#2900)
    'list_agent_parts', 'get_agent_part', 'create_agent_part', 'update_agent_part', 'fork_agent_part', 'delete_agent_part',
    'discover_agent_assets', 'import_agent_asset',
    'get_agent_setup', 'get_agent_activation', 'set_agent_setup', 'preview_agent_setup',
    'list_agent_templates', 'save_agent_template', 'push_agent_template', 'delete_agent_template', 'create_managed_agent',
    'restart_agent',
    // deleting an agent with its helpers (#3182)
    'delete_agent',
    'other',
  ]),
  mcpResult: enumAttr('clubhouse.mcp.result', ['ok', 'tool_error', 'threw']),
  /**
   * Why the tool registry refused a call before any handler ran (#2308). Only on
   * `clubhouse.mcp.tool_call` spans whose result is `tool_error`.
   */
  mcpRefusalReason: enumAttr('clubhouse.mcp.refusal.reason', ['group_off', 'unparseable', 'no_binding', 'unknown_tool', 'invalid_args', 'tool_denied', 'caller_unknown', 'no_grant', 'ask_first', 'other_machine']),
  binaryLookupTier: enumAttr('clubhouse.binary.lookup_tier', ['cache', 'well_known', 'path_scan', 'login_shell', 'not_found']),
  // Phase 4b: spawn, create, delete, kill, shoulder taps
  agentResume: boolAttr('clubhouse.agent.resume'),
  usesWorktree: boolAttr('clubhouse.agent.uses_worktree'),
  hooksEnabled: boolAttr('clubhouse.hooks.enabled'),
  wrapperApplied: boolAttr('clubhouse.wrapper.applied'),
  // A helper's start and the presets behind it (#2671). Codes only: never a raw model id, a task or a persona.
  helperRoutingRequestedCli: enumAttr('clubhouse.helper_routing.requested_cli', ['claude-code', 'codex-cli', 'copilot-cli', 'auto', 'other', 'unset']),
  helperRoutingDifficulty: enumAttr('clubhouse.helper_routing.difficulty', ['easy', 'medium', 'hard', 'none']),
  helperRoutingMode: enumAttr('clubhouse.helper_routing.mode', ['explicit', 'preset', 'auto']),
  helperRoutingEffort: enumAttr('clubhouse.helper_routing.effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'other']),
  helperRoutingPreset: enumAttr('clubhouse.helper_routing.preset', ['builtin', 'custom', 'none']),
  helperRoutingConfigSource: enumAttr('clubhouse.helper_routing.config_source', ['request', 'persona', 'orchestrator', 'auto', 'custom_mapping', 'builtin_mapping', 'cli_default']),
  helperRoutingReason: enumAttr('clubhouse.helper_routing.reason', ['explicit_request', 'persona_pinned', 'preset_on_cli', 'only_candidate', 'lower_pressure', 'lower_load', 'fair_rotation', 'better_quota_tier', 'unknown_fallback', 'last_resort_unmeasured', 'sticky', 'default_order']),
  helperRoutingFallback: enumAttr('clubhouse.helper_routing.fallback', ['none', 'builtin_preset', 'candidate_skipped', 'model_unverified']),
  helperRoutingPolicyVersion: intAttr('clubhouse.helper_routing.policy_version'),
  helperRoutingLoad: enumAttr('clubhouse.helper_routing.load_bucket', ['0', '1', '2-3', '4-7', '8+']),
  helperRoutingQuotaBasis: enumAttr('clubhouse.helper_routing.quota_basis', ['known', 'unknown_fallback', 'unknown_scored_as_healthy', 'none']),
  helperRoutingQuotaAge: enumAttr('clubhouse.helper_routing.quota_age', ['fresh', 'under_15m', 'over_15m', 'none']),
  helperAutoRefusal: enumAttr('clubhouse.helper_auto.refusal', ['auto_off', 'no_candidate', 'no_valid_mapping', 'auto_not_supported']),
  helperAutoCooldown: enumAttr('clubhouse.helper_auto.cooldown', ['auth', 'quota', 'availability']),
  helperQuotaState: enumAttr('clubhouse.helper_quota.state', ['known', 'low', 'near_limit', 'exhausted', 'unknown']),
  helperPresetsAction: enumAttr('clubhouse.helper_presets.action', ['set', 'toggle', 'reset_cell', 'reset_provider', 'reset_all']),
  helperPresetsSurface: enumAttr('clubhouse.helper_presets.surface', ['ui', 'mcp', 'mobile', 'annex_desktop', 'dispatcher', 'persona', 'cli', 'system']),

  // Helper decisions, outcomes and usage (#2747). Local recording only (EventOptions.localOnly): ids are hashed, models are hashes plus a family,
  // percentages are basis points, times are epoch ms. An absent attribute is unavailable; 0 is a reported zero.
  helperSchemaVersion: intAttr('clubhouse.helper_telemetry.schema_version'),
  helperDecisionIdHash: hashAttr('clubhouse.helper_decision.id_hash'),
  helperRunIdHash: hashAttr('clubhouse.helper_run.id_hash'),
  helperDecisionKnown: boolAttr('clubhouse.helper_decision.known'),
  helperDecisionOutcome: enumAttr('clubhouse.helper_decision.outcome', HELPER_DECISION_OUTCOMES),
  helperAskerCli: enumAttr('clubhouse.helper_decision.asker_cli', ['claude-code', 'codex-cli', 'copilot-cli', 'other', 'none']),
  helperTaskProfile: enumAttr('clubhouse.helper_decision.task_profile', HELPER_TASK_PROFILES),
  helperDecidedAtMs: intAttr('clubhouse.helper_decision.decided_at_ms'),
  helperDecisionAgeMs: intAttr('clubhouse.helper_decision.age_ms'),
  helperForecastWeeklySamples: intAttr('clubhouse.helper_forecast.weekly_samples'),
  helperForecastFiveHourSamples: intAttr('clubhouse.helper_forecast.five_hour_samples'),
  helperForecastWeeklyBp: intAttr('clubhouse.helper_forecast.weekly_bp'),
  helperForecastFiveHourBp: intAttr('clubhouse.helper_forecast.five_hour_bp'),
  helperForecastWeeklyObservedBp: intAttr('clubhouse.helper_forecast.weekly_observed_bp'),
  helperForecastFiveHourObservedBp: intAttr('clubhouse.helper_forecast.five_hour_observed_bp'),
  helperForecastWeeklyErrorBp: intAttr('clubhouse.helper_forecast.weekly_error_bp'),
  helperForecastFiveHourErrorBp: intAttr('clubhouse.helper_forecast.five_hour_error_bp'),
  helperForecastUsageSamples: intAttr('clubhouse.helper_forecast.usage_samples'),
  helperForecastAttribution: enumAttr('clubhouse.helper_forecast.attribution', ['whole_login_unknown']),
  helperForecastReason: enumAttr('clubhouse.helper_forecast.reason', ['observed', 'missing_baseline', 'reset', 'decreased', 'overlap', 'incomplete', 'restart']),
  helperModelHash: hashAttr('clubhouse.helper_decision.model_hash'),
  helperRequestedModelHash: hashAttr('clubhouse.helper_decision.requested_model_hash'),
  helperMappingRevisionHash: hashAttr('clubhouse.helper_decision.mapping_revision_hash'),
  helperMappingFingerprintHash: hashAttr('clubhouse.helper_decision.mapping_fingerprint_hash'),
  helperMappingKind: enumAttr('clubhouse.helper_decision.mapping_kind', MAPPING_KINDS),
  helperCandidateCount: intAttr('clubhouse.helper_decision.candidates'),
  helperEligibleCount: intAttr('clubhouse.helper_decision.eligible'),
  helperAutoEnabled: boolAttr('clubhouse.helper_decision.auto_enabled'),
  helperEnabledProviders: intAttr('clubhouse.helper_decision.enabled_providers'),
  helperThresholdQuotaLowBp: intAttr('clubhouse.helper_decision.quota_low_bp'),
  helperThresholdQuotaNearBp: intAttr('clubhouse.helper_decision.quota_near_limit_bp'),
  helperThresholdQuotaStaleMs: intAttr('clubhouse.helper_decision.quota_stale_ms'),
  helperThresholdReservationMs: intAttr('clubhouse.helper_decision.reservation_ms'),
  helperThresholdStickyMs: intAttr('clubhouse.helper_decision.sticky_ms'),
  helperThresholdLoadMargin: intAttr('clubhouse.helper_decision.load_margin'),
  helperCooldownsAuth: intAttr('clubhouse.helper_decision.cooldowns_auth'),
  helperCooldownsQuota: intAttr('clubhouse.helper_decision.cooldowns_quota'),
  helperCooldownsAvailability: intAttr('clubhouse.helper_decision.cooldowns_availability'),
  helperTieReason: enumAttr('clubhouse.helper_tie.reason', DECISION_TIE_REASONS),
  helperTieSetSize: intAttr('clubhouse.helper_tie.set_size'),
  helperTieBandBp: intAttr('clubhouse.helper_tie.band_bp'),
  helperTieByLoad: boolAttr('clubhouse.helper_tie.by_load'),
  helperTieCursorKeyHash: hashAttr('clubhouse.helper_tie.cursor_key_hash'),
  helperTieCursorBefore: intAttr('clubhouse.helper_tie.cursor_before'),
  helperTieCursorAfter: intAttr('clubhouse.helper_tie.cursor_after'),
  // One candidate of a decision.
  helperCandidateEligible: boolAttr('clubhouse.helper_candidate.eligible'),
  helperCandidateChosen: boolAttr('clubhouse.helper_candidate.chosen'),
  helperCandidateExcluded: enumAttr('clubhouse.helper_candidate.excluded', ['cli_disabled', 'cli_unavailable', 'auto_disabled', 'auto_not_supported', 'no_valid_mapping', 'mapping_changed', 'cooling_down', 'quota_near_limit', 'quota_exhausted', 'none']),
  helperCandidateMappedSource: enumAttr('clubhouse.helper_candidate.mapped_source', ['request', 'persona', 'orchestrator', 'auto', 'custom_mapping', 'builtin_mapping', 'cli_default']),
  helperCandidateMappedVerified: boolAttr('clubhouse.helper_candidate.mapped_verified'),
  helperCandidateLoadLive: intAttr('clubhouse.helper_candidate.load_live'),
  helperCandidateLoadReserved: intAttr('clubhouse.helper_candidate.load_reserved'),
  helperCandidateAccountKnown: boolAttr('clubhouse.helper_candidate.account_known'),
  helperCandidateTier: intAttr('clubhouse.helper_candidate.tier'),
  helperCandidateRank: intAttr('clubhouse.helper_candidate.rank'),
  helperScoreBasis: enumAttr('clubhouse.helper_candidate.score_basis', DECISION_SCORE_BASES),
  helperScoreWeeklyUsedBp: intAttr('clubhouse.helper_candidate.score_weekly_used_bp'),
  helperScoreCyclePhaseBp: intAttr('clubhouse.helper_candidate.score_cycle_phase_bp'),
  helperScoreTargetBp: intAttr('clubhouse.helper_candidate.score_target_bp'),
  helperScorePressureBp: intAttr('clubhouse.helper_candidate.score_pressure_bp'),
  // A quota reading, in a decision's candidate or on its own.
  helperQuotaSource: enumAttr('clubhouse.helper_quota.source', ['cli_query', 'session_event', 'none']),
  helperQuotaUnknownReason: enumAttr('clubhouse.helper_quota.unknown_reason', ['not_read', 'stale', 'not_applicable', 'read_failed', 'not_supported', 'none']),
  helperQuotaQuality: enumAttr('clubhouse.helper_quota.quality', DECISION_QUOTA_QUALITIES),
  helperQuotaAsOfMs: intAttr('clubhouse.helper_quota.as_of_ms'),
  helperQuotaMeasuredAtMs: intAttr('clubhouse.helper_quota.measured_at_ms'),
  helperQuotaLimitingWindow: enumAttr('clubhouse.helper_quota.limiting_window', ['weekly', 'fiveHour', 'other', 'model', 'none']),
  helperQuotaLimitReached: boolAttr('clubhouse.helper_quota.limit_reached'),
  helperQuotaWeeklyUsedBp: intAttr('clubhouse.helper_quota.weekly_used_bp'),
  helperQuotaWeeklyResetsMs: intAttr('clubhouse.helper_quota.weekly_resets_ms'),
  helperQuotaFiveHourUsedBp: intAttr('clubhouse.helper_quota.five_hour_used_bp'),
  helperQuotaFiveHourResetsMs: intAttr('clubhouse.helper_quota.five_hour_resets_ms'),
  helperQuotaOtherWindows: intAttr('clubhouse.helper_quota.other_windows'),
  helperQuotaTrigger: enumAttr('clubhouse.helper_quota.trigger', ['first', 'state_change', 'window_change', 'interval']),
  /** Weekly used basis points now minus the previous sample's, only when both are in one reset window. Provider-wide, so outside use is in it. */
  helperQuotaWeeklyDeltaBp: intAttr('clubhouse.helper_quota.weekly_delta_bp'),
  helperQuotaFiveHourDeltaBp: intAttr('clubhouse.helper_quota.five_hour_delta_bp'),
  helperQuotaResetBetween: boolAttr('clubhouse.helper_quota.reset_between'),
  helperQuotaDeltaSpanMs: intAttr('clubhouse.helper_quota.delta_span_ms'),
  // What became of a decision.
  helperSpawnResult: enumAttr('clubhouse.helper_spawn.result', HELPER_SPAWN_RESULTS),
  helperSpawnCooldown: enumAttr('clubhouse.helper_spawn.cooldown', HELPER_COOLDOWN_KINDS),
  helperSpawnDiffers: boolAttr('clubhouse.helper_spawn.differs_from_decision'),
  helperReuseKind: enumAttr('clubhouse.helper_reuse.kind', HELPER_REUSE_KINDS),
  helperRunOutcome: enumAttr('clubhouse.helper_run.outcome', HELPER_RUN_OUTCOMES),
  helperRunDurationMs: intAttr('clubhouse.helper_run.duration_ms'),
  helperRunTurns: intAttr('clubhouse.helper_run.turns'),
  helperRunAuthErrors: intAttr('clubhouse.helper_run.auth_errors'),
  helperRunRateLimitErrors: intAttr('clubhouse.helper_run.rate_limit_errors'),
  helperRunQuotaErrors: intAttr('clubhouse.helper_run.quota_errors'),
  helperRunModelHash: hashAttr('clubhouse.helper_run.model_hash'),
  helperRunNativeResumed: boolAttr('clubhouse.helper_run.native_resumed'),
  helperRunUsageSamplesDropped: intAttr('clubhouse.helper_run.usage_samples_dropped'),
  // One usage sample. Token figures follow src/shared/chat TokenUsage: input includes cache reads and writes.
  helperUsageKind: enumAttr('clubhouse.helper_usage.kind', USAGE_SAMPLE_KINDS),
  helperUsageSource: enumAttr('clubhouse.helper_usage.source', USAGE_SOURCES),
  helperUsageDedup: enumAttr('clubhouse.helper_usage.dedup', USAGE_DEDUPS),
  helperUsageScope: enumAttr('clubhouse.helper_usage.scope', USAGE_SCOPES),
  helperUsageBaseline: enumAttr('clubhouse.helper_usage.baseline', USAGE_BASELINES),
  helperUsageCompleteness: enumAttr('clubhouse.helper_usage.completeness', USAGE_COMPLETENESS),
  helperUsageInputTokens: intAttr('clubhouse.helper_usage.input_tokens'),
  helperUsageCachedInputTokens: intAttr('clubhouse.helper_usage.cached_input_tokens'),
  helperUsageCacheWriteTokens: intAttr('clubhouse.helper_usage.cache_write_tokens'),
  helperUsageOutputTokens: intAttr('clubhouse.helper_usage.output_tokens'),
  helperUsageReasoningTokens: intAttr('clubhouse.helper_usage.reasoning_tokens'),
  helperUsageMeasuredAtMs: intAttr('clubhouse.helper_usage.measured_at_ms'),
  helperUsageTurnIndex: intAttr('clubhouse.helper_usage.turn_index'),
  helperUsageTurnDurationMs: intAttr('clubhouse.helper_usage.turn_duration_ms'),
  /** The provider's running total went down, so it was reset or compacted and no delta is claimed. */
  helperUsageReset: boolAttr('clubhouse.helper_usage.reset'),
  /** Turns of the run that reported no usage at all. */
  helperUsageTurnsMissing: intAttr('clubhouse.helper_usage.turns_missing'),
  helperUsageSubagentExcluded: boolAttr('clubhouse.helper_usage.subagent_excluded'),
  /** Bucketed from the model string; never the raw model name. */
  modelFamily: enumAttr('clubhouse.model.family', ['opus', 'sonnet', 'haiku', 'gpt-5', 'default', 'other']),
  /**
   * Who asked for a kill. Renderer kills over the agent IPC (including
   * quick-agent auto-stop) are `user`; `other` is a kill that reached the
   * runtime managers without a known caller (terminal IPC, force-kill).
   */
  killTrigger: enumAttr('clubhouse.kill.trigger', ['user', 'agent_tool', 'annex', 'shutdown', 'other']),
  deleteMode: enumAttr('clubhouse.agent.delete.mode', [
    'standard', 'commit_push', 'cleanup_branch', 'save_patch', 'force', 'unregister',
  ]),
  tapBroadcast: boolAttr('clubhouse.tap.broadcast'),
  // Session-id capture and resume (#2305). Never the session id itself.
  /** What a run's end did with the agent's resume id. */
  sessionCaptureResult: enumAttr('clubhouse.session.capture.result', [
    'captured', 'kept_previous', 'ignored_not_in_store', 'ignored_foreign',
    'resume_failed_no_session', 'resume_failed_early_exit', 'persist_failed', 'capture_failed',
  ]),
  /**
   * Where the saved id came from: the id Clubhouse assigned the run, the CLI's
   * output (regex), the CLI's own run files (Codex rollouts, #2134), the id the
   * run was resumed with, or the chat driver's report.
   */
  sessionCaptureSource: enumAttr('clubhouse.session.capture.source', [
    'assigned', 'output_scrape', 'run_store', 'resumed_id', 'provider_reported', 'none',
  ]),
  /** Why a saved resume id was cleared (#2113): where the dead session was noticed. */
  sessionStaleReason: enumAttr('clubhouse.session.stale.reason', ['store_missing', 'chat_not_found', 'exit_not_found', 'exit_early']),
  /** How a durable agent's wake went: resumed, started fresh (and why), or a terminal resume that failed. */
  sessionResumeResult: enumAttr('clubhouse.session.resume.result', [
    'resumed', 'fresh_not_found', 'fresh_stalled', 'fresh_user', 'fresh_other', 'failed_not_found', 'failed_early_exit',
  ]),
  targetsCount: intAttr('clubhouse.targets.count'),
  deliveryResult: enumAttr('clubhouse.delivery.result', ['delivered', 'not_running', 'unsupported_runtime']),
  // Workspace (§4.7–4.10, Phase 5). Counts are bucketed with countBucket().
  gitOp: enumAttr('clubhouse.git.op', GIT_OPS),
  gitTimedOut: boolAttr('clubhouse.git.timed_out'),
  gitStatusFileCount: enumAttr('clubhouse.git.status.file_count_bucket', COUNT_BUCKETS),
  fileOp: enumAttr('clubhouse.file.op', ['read', 'write', 'read_binary', 'read_tree', 'mkdir', 'delete', 'rename', 'copy', 'stat']),
  fileResult: enumAttr('clubhouse.file.result', ['ok', 'error']),
  treeNodeCount: enumAttr('clubhouse.tree.node_count_bucket', COUNT_BUCKETS),
  treeHitCap: boolAttr('clubhouse.tree.hit_cap'),
  searchEngine: enumAttr('clubhouse.search.engine', ['rg', 'node']),
  searchTruncated: boolAttr('clubhouse.search.truncated'),
  searchMatchCount: enumAttr('clubhouse.search.match_count_bucket', COUNT_BUCKETS),
  searchRegex: boolAttr('clubhouse.search.regex'),
  searchCaseSensitive: boolAttr('clubhouse.search.case_sensitive'),
  searchWholeWord: boolAttr('clubhouse.search.whole_word'),
  editorBucket: enumAttr('clubhouse.editor.bucket', ['vscode', 'cursor', 'zed', 'jetbrains', 'other']),
  /** Built-in plugin ids are sent as-is; any other plugin is `other` plus `clubhouse.plugin.id_hash`. */
  pluginRef: enumAttr('clubhouse.plugin.ref', [...BUILTIN_PLUGIN_IDS, 'other']),
  pluginIdHash: hashAttr('clubhouse.plugin.id_hash'),
  pluginOrigin: enumAttr('clubhouse.plugin.origin', ['builtin', 'marketplace', 'sideloaded']),
  pluginScope: enumAttr('clubhouse.plugin.scope', ['project', 'app', 'dual']),
  /** The manifest's `engine.api` (0.7, 0.9, ...) as a string; unsupported versions become `other`. */
  pluginApiVersion: enumAttr('clubhouse.plugin.api_version', PLUGIN_API_VERSION_VALUES),
  attempt: intAttr('clubhouse.attempt'),
  pluginProtocolResult: enumAttr('clubhouse.plugin.protocol.result', ['ok', 'denied', 'not_found']),
  canvasLoadResult: enumAttr('clubhouse.canvas.load.result', ['ok', 'new', 'recovered_from_backup', 'degraded', 'unreadable', 'failed']),
  canvasCount: intAttr('clubhouse.canvas.count'),
  canvasViewCount: enumAttr('clubhouse.canvas.view.count_bucket', COUNT_BUCKETS),

  // Workspace 5b: marketplace, plugin updates, settings and feature events (§4.11, §4.14)
  registryKind: enumAttr('clubhouse.registry.kind', ['official', 'custom']),
  cacheHit: boolAttr('clubhouse.cache.hit'),
  httpStatusCode: intAttr('http.response.status_code'),
  installFailureStage: enumAttr('clubhouse.install.failure_stage', ['invalid_id', 'download_http', 'integrity', 'extract', 'no_manifest', 'swap', 'restore']),
  updatesAvailable: intAttr('clubhouse.updates.available.count'),
  updatesIncompatible: intAttr('clubhouse.updates.incompatible.count'),
  settingsKey: enumAttr('clubhouse.settings.key', SETTINGS_KEYS),
  // Audit events (#2920): who changed what. The key and values go in the local record's detail only.
  auditSurface: enumAttr('clubhouse.audit.surface', ['ui', 'mcp', 'mobile', 'annex_desktop', 'dispatcher', 'persona', 'cli', 'system']),
  auditScope: enumAttr('clubhouse.audit.scope', ['app', 'project', 'agent']),
  auditOutcome: enumAttr('clubhouse.audit.outcome', ['ok', 'refused', 'error']),
  auditTool: enumAttr('clubhouse.audit.tool', ['set_orchestrator_helpers', 'connect_orchestrators', 'disconnect_orchestrators', 'set_connection_tools', 'change_provider', 'preview_provider', 'create_managed_agent', 'connect_agents', 'disconnect_agents']),
  auditActorIdHash: hashAttr('clubhouse.audit.actor.id_hash'),
  // Clubhouse permissions (#2973, part of #2921): decisions, requests and changes. Enums only; ids hashed.
  grantAction: enumAttr('clubhouse.grant.action', GRANT_ACTIONS),
  grantDecision: enumAttr('clubhouse.grant.decision', ['refused', 'asked']),
  grantRefusalReason: enumAttr('clubhouse.grant.refusal_reason', ['no_grant', 'raise_self', 'exceeds_caller', 'ask_first']),
  grantTargetKind: enumAttr('clubhouse.grant.target_kind', ['agent', 'browser', 'project', 'group_project', 'app', 'library', 'action', 'connection']),
  grantRequestKind: enumAttr('clubhouse.grant.request.kind', ['call', 'grant']),
  grantRequestOutcome: enumAttr('clubhouse.grant.request.outcome', ['allowed', 'declined', 'expired']),
  grantChangeMode: enumAttr('clubhouse.grant.change.mode', ['off', 'ask', 'allow', 'reset']),
  grantChangeLayer: enumAttr('clubhouse.grant.change.layer', ['own', 'template', 'control', 'connection']),
  auditTargetIdHash: hashAttr('clubhouse.audit.target.id_hash'),
  themeBuiltinId: enumAttr('clubhouse.theme.builtin_id', [...BUILTIN_THEME_IDS, 'other']),
  popoutType: enumAttr('clubhouse.popout.type', ['agent', 'canvas']),
  /**
   * A bulletin post (§12 H8): `evicted_message` when the topic's own cap
   * dropped older messages, `evicted_topic` when the board-wide cap dropped
   * messages from other topics, `rejected` for an oversized body.
   */
  bulletinPostResult: enumAttr('clubhouse.bulletin.post.result', ['ok', 'evicted_message', 'evicted_topic', 'rejected']),
  mcpToolsCount: enumAttr('clubhouse.mcp.tools.count_bucket', COUNT_BUCKETS),
  mcpToolsEmpty: boolAttr('clubhouse.mcp.tools.empty'),

  // Annex (§4.12, §7, Phase 6). Peer identity is never an attribute: no
  // fingerprints, aliases, hosts, addresses or ports.
  annexPeerInstanceId: uuidAttr('clubhouse.annex.peer.instance_id'),
  annexConnectionId: uuidAttr('clubhouse.annex.connection_id'),
  annexAttemptId: uuidAttr('clubhouse.annex.attempt_id'),
  annexRole: enumAttr('clubhouse.annex.role', ['satellite', 'controller']),
  annexTls: boolAttr('clubhouse.annex.tls'),
  annexAuthMode: enumAttr('clubhouse.annex.auth_mode', ['mtls', 'bearer']),
  /** mTLS clients are desktop controllers; bearer clients are the mobile app. */
  annexClientKind: enumAttr('clubhouse.annex.client.kind', ['desktop', 'mobile', 'unknown']),
  /** Address family of the peer address used, never the address (§12 H9). */
  addrFamily: enumAttr('clubhouse.net.addr_family', ['ipv4', 'ipv6', 'hostname']),
  annexPairResult: enumAttr('clubhouse.annex.pair.result', [
    'ok', 'invalid_pin', 'rate_limited', 'locked', 'invalid_key', 'invalid_request', 'identity_not_ready', 'other',
  ]),
  annexDisconnectReason: enumAttr('clubhouse.annex.disconnect.reason', [
    'heartbeat_timeout', 'heartbeat_failed', 'ws_error', 'connection_closed', 'user', 'other',
  ]),
  attemptBucket: enumAttr('clubhouse.attempt_bucket', ['1', '2', '3-5', '6-10', '>10']),
  /** Event types the satellite streams; anything unlisted is `other`. */
  annexEventType: enumAttr('clubhouse.annex.event.type', [
    'pty:data', 'pty:exit', 'hook:event', 'chat:event', 'permission:request', 'permission:response',
    'agent:spawned', 'agent:woken', 'agent:status', 'agent:completed', 'snapshot', 'canvas:state', 'theme:changed',
    'group-project:list', 'group-project:changed', 'bulletin:message', 'pty:attach:ack', 'other',
  ]),
  /** A permission request's encoded size, in fixed steps. No contents. */
  annexToolInputBucket: enumAttr('clubhouse.annex.tool_input.bucket', ['<=64k', '<=256k', '<=1m', '>1m']),
  /** How a chat page fit its pending requests: minimal rows, or none and an error. */
  annexChatPageStage: enumAttr('clubhouse.annex.chat_page.stage', ['minimal', 'error']),
  /** What was done with a frame over the limit. */
  annexFrameAction: enumAttr('clubhouse.annex.frame.action', ['fallback', 'sent_over_limit']),
  /** How a snapshot went: sent whole, sent with fewer icons, too large even so, or not sent. */
  annexSnapshotResult: enumAttr('clubhouse.annex.snapshot.result', [
    'ok', 'icons_left_out', 'canvas_omitted', 'icons_dropped', 'over_mobile_limit', 'build_failed', 'send_failed',
  ]),
  /** Why a snapshot went out: a client connected, or something changed and every client gets a new one. */
  annexSnapshotTrigger: enumAttr('clubhouse.annex.snapshot.trigger', ['connect', 'refresh']),
  annexRemoteAction: enumAttr('clubhouse.annex.remote.action', ['spawn', 'wake']),
  annexControlChannel: enumAttr('clubhouse.annex.control.channel', ['ws', 'rest']),
  annexReplayResult: enumAttr('clubhouse.annex.replay.result', ['ok', 'gap', 'send_failed']),
  identityRegenReason: enumAttr('clubhouse.annex.identity.reason', ['corrupt', 'reset']),
  /**
   * Satellite REST route template, from ANNEX_HTTP_ROUTE_TABLE (a test keeps
   * them in sync); never a concrete path or query.
   */
  // Goobers (§4.13, §12 H12, Phase 6b). Codes only, never messages: most
  // messages interpolate the instance root, address or instance ids.
  goobersDaemonState: enumAttr('clubhouse.goobers.state', ['running', 'not-running', 'starting', 'stopping', 'unknown']),
  goobersConnection: enumAttr('clubhouse.goobers.connection', ['idle', 'connecting', 'connected', 'degraded', 'error']),
  goobersError: enumAttr('clubhouse.goobers.error', [
    'none', 'unsupported-platform', 'not-configured', 'not-a-goobers-instance-root', 'decommissioned-root',
    'invalid-instance-id', 'instance-id-unreadable', 'invalid-root', 'binary-not-found', 'binary-not-executable',
    'non-loopback-address', 'unexpected-readyz-status', 'identity-check-failed', 'identity-unverifiable',
    'identity-mismatch', 'auth-required', 'recovering', 'recovery-stalled', 'degraded', 'lifecycle-busy',
    'daemon-control-disabled', 'daemon-start-failed', 'daemon-start-unknown', 'daemon-stop-failed', 'other',
  ]),
  goobersStreamMode: enumAttr('clubhouse.goobers.stream.mode', ['live', 'reconnecting', 'polling', 'unavailable']),
  goobersModel: enumAttr('clubhouse.goobers.model', ['instance', 'run', 'workflow']),
  sseTerminalReason: enumAttr('clubhouse.sse.terminal_reason', ['auth-required', 'no-read-model', 'schema-changed']),
  // Feedback (Framebriar screenshot feedback, #2309). States, counts and codes only:
  // never notes, images or invitations. The report id is `feedbackReportId`, for the
  // developer destination only (#2524).
  feedbackStage: enumAttr('clubhouse.feedback.stage', ['start', 'connect', 'capture', 'submit', 'deliver']),
  feedbackError: enumAttr('clubhouse.feedback.error', [
    // SDK and outbox codes, in their own spelling
    'capture-failed', 'invalid-media', 'feedback-unavailable', 'storage-full', 'storage-unavailable', 'invalid-input',
    'conflict', 'secure-store-unavailable', 'invalid-store', 'network', 'invalid-ack',
    // Clubhouse's own send checks
    'screenshot-expired', 'notes-required', 'shot-unavailable', 'flattened-required', 'not-running', 'draft-required', 'enrollment-changed',
    // Why a connect returned false (connectFailureClass)
    'invitation-malformed', 'busy', 'access-refused', 'timeout', 'connection-uncertain', 'enrollment-response-rejected',
    // A queued report the outbox gave up on
    'undeliverable',
    'unknown', 'other',
  ]),
  /**
   * The Framebriar report id, a random UUID with no report content, on
   * `feedback.submitted` only. Framebriar's own name, and only the developer
   * destination receives it (#2524): the others drop it.
   */
  feedbackReportId: uuidAttr('feedback.report.id'),
  feedbackScreenshot: boolAttr('clubhouse.feedback.screenshot'),
  feedbackAnnotated: boolAttr('clubhouse.feedback.annotated'),
  feedbackShots: intAttr('clubhouse.feedback.shots'),
  feedbackWindows: intAttr('clubhouse.feedback.windows'),
  feedbackTrigger: enumAttr('clubhouse.feedback.trigger', ['button', 'shortcut']),
  feedbackAccessState: enumAttr('clubhouse.feedback.access.state', [...FEEDBACK_ACCESS_STATES]),
  feedbackAccessFrom: enumAttr('clubhouse.feedback.access.from', [...FEEDBACK_ACCESS_STATES, 'none']),
  feedbackNotice: enumAttr('clubhouse.feedback.notice', ['none', 'expired', 'access-required', 'connection-uncertain', 'enrollment-response-rejected', 'migration-required']),
  feedbackRefusal: enumAttr('clubhouse.feedback.refusal', ['not-configured', 'no-main-window', 'unauthorized-caller']),
  /**
   * IPC channel, from the fixed IPC constants; never a dynamic name. Channels
   * built at runtime (e.g. per-key managed-settings channels) are `other`.
   */
  ipcChannel: enumAttr('clubhouse.ipc.channel', [...ipcChannelNames(), 'other']),
  annexRoute: enumAttr('clubhouse.annex.route', [
    'POST /api/v1/mobile/agents/:id/attachments',
    'GET /api/v1/mobile/agents/:id/content',
    'GET /api/v1/mobile/agents/:id/link',
    'GET /api/v1/mobile/capabilities',
    'GET /api/v1/mobile/network',
    'POST /api/v1/mobile/network/members',
    'POST /api/v1/network/agent-call',
    'POST /api/v1/network/agent-delivery-capabilities',
    'POST /api/v1/network/connections',
    'GET /api/v1/mobile/canvas',
    'GET /api/v1/mobile/canvas/:id',
    'DELETE /api/v1/mobile/pairing',
    'GET /api/v1/mobile/agents/state',
    'GET /api/v1/mobile/agents/:id/chat',
    'GET /api/v1/mobile/agents/:id/chat/sessions',
    'GET /api/v1/mobile/agents/:id/chat/events/:id',
    'POST /api/v1/mobile/commands',
    'GET /api/v1/mobile/projects/:id/create-options',
    'GET /api/v1/mobile/agents/:id/settings',
    'GET /api/v1/mobile/helper-routing',
    'GET /api/v1/mobile/dispatcher/settings',
    'GET /api/v1/identity',
    'GET /api/v1/status',
    'GET /api/v1/projects',
    'GET /api/v1/projects/:id/agents',
    'GET /api/v1/agents/:id/buffer',
    'GET /api/v1/projects/:id/files/tree',
    'GET /api/v1/projects/:id/files/read',
    'GET /api/v1/projects/:id/git/info',
    'GET /api/v1/projects/:id/git/log',
    'GET /api/v1/projects/:id/git/diff',
    'GET /api/v1/projects/:id/git/show-commit',
    'GET /api/v1/projects/:id/git/commit-diff',
    'POST /api/v1/projects/:id/git/:op',
    'GET /api/v1/agents/:id/sessions',
    'GET /api/v1/agents/:id/sessions/:id/transcript',
    'GET /api/v1/agents/:id/sessions/:id/summary',
    'POST /api/v1/projects/:id/agents/quick',
    'POST /api/v1/agents/:id/agents/quick',
    'POST /api/v1/agents/:id/wake',
    'POST /api/v1/agents/:id/permission-response',
    'POST /api/v1/agents/:id/message',
    'POST /api/v1/projects/:id/agents/durable',
    'POST /api/v1/projects/:id/agents/:id/delete',
    'GET /api/v1/projects/:id/agents/:id/worktree-status',
    'GET /api/v1/group-projects',
    'GET /api/v1/group-projects/:id',
    'GET /api/v1/group-projects/:id/bulletin/digest',
    'GET /api/v1/group-projects/:id/bulletin/topics/:id',
    'GET /api/v1/group-projects/:id/bulletin/messages',
    'POST /api/v1/group-projects/:id/bulletin/messages',
    'POST /api/v1/group-projects/:id/shoulder-tap',
    'POST /api/v1/group-projects/:id/polling',
    'DELETE /api/v1/group-projects/:id/bulletin/topics/:id/messages/:id',
    'DELETE /api/v1/group-projects/:id/bulletin/topics/:id',
    'PATCH /api/v1/group-projects/:id/bulletin/topics/:id/protection',
    'POST /api/v1/inject-message',
    'GET /api/v1/group-projects/:id/members',
    'PATCH /api/v1/group-projects/:id',
    'GET /api/v1/icons/agent/:id',
    'GET /api/v1/icons/project/:id',
    'other',
  ]),

  // appLog bridge (§6.6, Phase 7)
  configFormat: enumAttr('clubhouse.config.format', ['json', 'toml']),

  // Actions (#2918, #2956). Closed codes and counts only: never an action's name, steps' text, prompts or
  // reasons in words. The action id hash is on the Detailed `clubhouse.action.run_detail` only.
  actionOwner: enumAttr('clubhouse.action.owner', ['user', 'dispatcher', 'agent', 'app']),
  actionTrigger: enumAttr('clubhouse.action.trigger', ['schedule', 'once', 'event', 'catch_up', 'manual']),
  actionEvent: enumAttr('clubhouse.action.event', ACTION_EVENT_KINDS),
  actionDelayed: boolAttr('clubhouse.action.delayed'),
  actionWait: enumAttr('clubhouse.action.wait', ['started', 'restarted', 'cancelled', 'fired', 'dropped']),
  actionOverlap: enumAttr('clubhouse.action.overlap', ['skipped', 'queued']),
  actionLimit: enumAttr('clubhouse.action.limit', ['chain', 'self', 'hourly']),
  actionChainDepth: enumAttr('clubhouse.action.chain_depth', ['0', '1', '2', '3+']),
  actionMissedRule: enumAttr('clubhouse.action.missed_rule', MISSED_RUN_RULES),
  actionMissedBucket: enumAttr('clubhouse.action.missed_bucket', ['0', '1', '2-4', '5-9', '10+']),
  actionRunOutcome: enumAttr('clubhouse.action.run.outcome', ['done', 'failed', 'cancelled', 'skipped', 'throttled', 'expired']),
  actionRunReason: enumAttr('clubhouse.action.run.reason', [
    'none', 'self_trigger', 'chain_limit', 'overlap', 'hourly_limit', 'throttled', 'delivery_expired', 'delivery_replaced', 'delivery_dropped', 'lifetime_limit', 'event_filter', 'missed', 'condition_changed', 'turned_off', 'edited',
    'deleted', 'rights_refused', 'step_failed', 'step_threw',
  ]),
  actionRunSteps: intAttr('clubhouse.action.run.steps'),
  actionRunDurationMs: intAttr('clubhouse.action.run.duration_ms'),
  actionRunFailedStep: enumAttr('clubhouse.action.run.failed_step', [...ACTION_STEP_KINDS, 'none']),
  actionStepKind: enumAttr('clubhouse.action.step.kind', ACTION_STEP_KINDS),
  actionStepOutcome: enumAttr('clubhouse.action.step.outcome', ['done', 'failed']),
  actionStepIndex: intAttr('clubhouse.action.step.index'),
  actionIdHash: hashAttr('clubhouse.action.id_hash'),

  // Dispatcher (#3052, epic #3034). Counts, sizes and closed codes only: never message text, page
  // contents, page or agent names, paths or ids. Which of its agents did the work is never sent.
  /** Which side of the usage split a turn counts toward (shared/dispatcher-usage.ts). */
  dispatcherWork: enumAttr('clubhouse.dispatcher.work', DISPATCHER_USAGE_KINDS),
  /** False when the provider reported no tokens or cost for the turn; the token attributes are then left out. */
  dispatcherTurnUsageReported: boolAttr('clubhouse.dispatcher.turn.usage_reported'),
  dispatcherTurnInputTokens: intAttr('clubhouse.dispatcher.turn.input_tokens'),
  dispatcherTurnCachedInputTokens: intAttr('clubhouse.dispatcher.turn.cached_input_tokens'),
  dispatcherTurnCacheWriteTokens: intAttr('clubhouse.dispatcher.turn.cache_write_tokens'),
  dispatcherTurnOutputTokens: intAttr('clubhouse.dispatcher.turn.output_tokens'),
  dispatcherTurnReasoningTokens: intAttr('clubhouse.dispatcher.turn.reasoning_tokens'),
  /** The turn's cost in millionths of a dollar, from providers that report one. */
  dispatcherTurnCostMicroUsd: intAttr('clubhouse.dispatcher.turn.cost_micro_usd'),
  dispatcherMemoryPages: intAttr('clubhouse.dispatcher.memory.pages'),
  dispatcherMemoryBytes: intAttr('clubhouse.dispatcher.memory.bytes'),
  dispatcherMemoryTopics: intAttr('clubhouse.dispatcher.memory.topics'),
  dispatcherMemoryAgentPages: intAttr('clubhouse.dispatcher.memory.agent_pages'),
  dispatcherMemoryTimelinePages: intAttr('clubhouse.dispatcher.memory.timeline_pages'),
  dispatcherMemoryIndexBytes: intAttr('clubhouse.dispatcher.memory.index_bytes'),
  dispatcherMemoryIndexCapBytes: intAttr('clubhouse.dispatcher.memory.index_cap_bytes'),
  dispatcherMemoryIndexOverCap: boolAttr('clubhouse.dispatcher.memory.index_over_cap'),
  /** Topics no other page, the index included, links to or names. */
  dispatcherMemoryUnlinkedTopics: intAttr('clubhouse.dispatcher.memory.unlinked_topics'),
  /** Topics untouched for the upkeep's stale age (30 days), confirmed or not. */
  dispatcherMemoryStaleTopics: intAttr('clubhouse.dispatcher.memory.stale_topics'),
  dispatcherMemoryConflictingPages: intAttr('clubhouse.dispatcher.memory.conflicting_pages'),
  dispatcherMemoryNeglectedPages: intAttr('clubhouse.dispatcher.memory.neglected_pages'),
  dispatcherMemoryUnconfirmedTopics: intAttr('clubhouse.dispatcher.memory.unconfirmed_topics'),
  /** Links between memory pages that upkeep couldn't fix. */
  dispatcherMemoryBrokenLinks: intAttr('clubhouse.dispatcher.memory.broken_links'),
  /** Cited files (transcripts, mostly) that are gone. */
  dispatcherMemoryMissingSources: intAttr('clubhouse.dispatcher.memory.missing_sources'),
  dispatcherUpkeepRolledDays: intAttr('clubhouse.dispatcher.upkeep.rolled_days'),
  dispatcherUpkeepRolledWeeks: intAttr('clubhouse.dispatcher.upkeep.rolled_weeks'),
  dispatcherUpkeepLinksFixed: intAttr('clubhouse.dispatcher.upkeep.links_fixed'),
  /** Stale unconfirmed topics moved to the archive. */
  dispatcherUpkeepPruned: intAttr('clubhouse.dispatcher.upkeep.pruned'),
  /** Changed pages handed to the Dispatcher to check against transcripts. */
  dispatcherUpkeepToCheck: intAttr('clubhouse.dispatcher.upkeep.to_check'),
  /** Whether the Dispatcher was asked to review anything (a background turn follows). */
  dispatcherUpkeepReview: boolAttr('clubhouse.dispatcher.upkeep.review'),
  /** What the Dispatcher said a report was (tell_user's kind). */
  dispatcherNewsKind: enumAttr('clubhouse.dispatcher.news.kind', ['needs_user', 'answer', 'routine', 'check_in']),
  /** What triage did with it. */
  dispatcherNewsShow: enumAttr('clubhouse.dispatcher.news.show', ['now', 'check_in', 'later', 'never']),
  dispatcherNewsReason: enumAttr('clubhouse.dispatcher.news.reason', [
    'none', 'needs_user', 'answer', 'routine', 'nothing_asked', 'empty', 'duplicate', 'nothing_changed',
  ]),
  /** The report is an agent's news rather than the Dispatcher's own words. */
  dispatcherNewsFromAgent: boolAttr('clubhouse.dispatcher.news.from_agent'),
  /** Held items a check-in summary took with it. */
  dispatcherNewsHeld: intAttr('clubhouse.dispatcher.news.held'),
  /** How an agent's news shown now was put into the chat: the rewrite step, its fallback, or neither. */
  dispatcherNewsRewrite: enumAttr('clubhouse.dispatcher.news.rewrite', ['none', 'rewrite', 'fallback']),
  dispatcherNewsRewriteReason: enumAttr('clubhouse.dispatcher.news.rewrite_reason', [
    'none', 'no_raw', 'auto_not_supported', 'no_valid_mapping', 'run_failed', 'empty',
  ]),
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
  // Goobers (§4.13, Phase 6b)
  /** subscribe() → the first reconcile (liveness) result. */
  'clubhouse.goobers.activate': { level: 'standard', root: true },
  'clubhouse.goobers.daemon.start': { level: 'standard', root: true },
  'clubhouse.goobers.daemon.stop': { level: 'standard', root: true },
  /** One renderer ipcRenderer.invoke handled in main, per channel. Detailed only. */
  'clubhouse.ipc.invoke': { level: 'detailed', root: true },
  /** pre_tool → post_tool / tool_error from the hook server. Detailed only. */
  'clubhouse.agent.tool_call': { level: 'detailed', root: true },
  /** Durable agent creation (IPC entry → config written). */
  'clubhouse.agent.create': { level: 'standard', root: true },
  /** Durable agent deletion, any mode. */
  'clubhouse.agent.delete': { level: 'standard', root: true },
  /** spawnAgent entry → process launched (or the throw). */
  'clubhouse.agent.spawn': { level: 'standard', root: true },
  'clubhouse.provider.resolve': { level: 'standard', root: false },
  'clubhouse.provider.check_availability': { level: 'standard', root: false },
  'clubhouse.agent.materialize': { level: 'standard', root: false },
  'clubhouse.agent.prepare_pty': { level: 'standard', root: false },
  'clubhouse.hooks.configure': { level: 'standard', root: false },
  'clubhouse.mcp.inject': { level: 'standard', root: false },
  'clubhouse.provider.build_command': { level: 'standard', root: false },
  'clubhouse.pty.spawn': { level: 'standard', root: false },
  'clubhouse.headless.spawn': { level: 'standard', root: false },
  /** Chat driver start inside a spawn; only when a chat start really began. */
  'clubhouse.chat.start': { level: 'standard', root: false },
  // Annex (§4.12, Phase 6)
  /** Satellite start → both listeners up. */
  'clubhouse.annex.server.start': { level: 'standard', root: true },
  /** Pairing: client pairWithService, or the satellite's POST /pair. */
  'clubhouse.annex.pair': { level: 'standard', root: true },
  /** Controller: GET /identity for a discovered service. */
  'clubhouse.annex.discover': { level: 'standard', root: true },
  /** Controller: connectToSatellite → first snapshot (or failure). */
  'clubhouse.annex.connect': { level: 'standard', root: true },
  /** Controller: agent:spawn / agent:wake sent to a satellite; carries traceparent. */
  'clubhouse.annex.remote_spawn': { level: 'standard', root: true },
  /** Authenticated satellite request, per bounded route template. */
  'clubhouse.annex.command': { level: 'standard', root: true },
  'clubhouse.annex.rest': { level: 'standard', root: true },
  /** killAgent → exit. Replayed at exit; carries the trigger and the stage reached. */
  'clubhouse.agent.kill': { level: 'standard', root: true },
  /** One shoulder tap (direct or broadcast) to group-project members. */
  'clubhouse.group.shoulder_tap': { level: 'standard', root: true },
  // Workspace (§4.7–4.10, Phase 5)
  'clubhouse.project.add': { level: 'standard', root: true },
  'clubhouse.project.add.ensure_gitignore': { level: 'standard', root: false },
  'clubhouse.project.remove': { level: 'standard', root: true },
  'clubhouse.project.git_init': { level: 'standard', root: true },
  'clubhouse.git.checkout': { level: 'standard', root: true },
  'clubhouse.git.stage': { level: 'standard', root: true },
  'clubhouse.git.unstage': { level: 'standard', root: true },
  'clubhouse.git.stage_all': { level: 'standard', root: true },
  'clubhouse.git.unstage_all': { level: 'standard', root: true },
  'clubhouse.git.discard': { level: 'standard', root: true },
  'clubhouse.git.commit': { level: 'standard', root: true },
  'clubhouse.git.push': { level: 'standard', root: true },
  'clubhouse.git.open_pr': { level: 'standard', root: true },
  'clubhouse.git.pull': { level: 'standard', root: true },
  'clubhouse.git.create_branch': { level: 'standard', root: true },
  'clubhouse.git.stash': { level: 'standard', root: true },
  'clubhouse.git.stash_pop': { level: 'standard', root: true },
  'clubhouse.git.diff': { level: 'standard', root: true },
  'clubhouse.git.show_commit': { level: 'standard', root: true },
  'clubhouse.git.worktree_list': { level: 'standard', root: true },
  /** Children of the agent create/delete flows (Phase 4). */
  'clubhouse.git.worktree_add': { level: 'standard', root: false },
  'clubhouse.git.worktree_remove': { level: 'standard', root: false },
  /** Exemplar for a status poll slower than 2 s; polls themselves never get spans. */
  'clubhouse.git.status.slow': { level: 'detailed', root: true },
  'clubhouse.file.tree.read': { level: 'standard', root: true },
  'clubhouse.search.query': { level: 'standard', root: true },
  'clubhouse.editor.open_external': { level: 'standard', root: true },
  'clubhouse.editor.monaco_load': { level: 'standard', root: true },
  'clubhouse.plugin.activate': { level: 'standard', root: true },
  'clubhouse.canvas.load': { level: 'standard', root: true },
  // Workspace 5b (§4.11)
  'clubhouse.marketplace.fetch_registry': { level: 'standard', root: true },
  'clubhouse.plugin.install': { level: 'standard', root: true },
  'clubhouse.plugin.update_check': { level: 'standard', root: true },
  'clubhouse.plugin.update': { level: 'standard', root: true },
  'clubhouse.plugin.uninstall': { level: 'standard', root: true },
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
  'clubhouse.ui.interaction.duration': {
    kind: 'histogram',
    unit: 's',
    level: 'standard',
    description: 'Input to next paint for clicks, keys and wheel (Event Timing, interactions of 16 ms and over)',
    attributes: ['clubhouse.view', 'clubhouse.window.kind', 'clubhouse.ui.surface', 'clubhouse.ui.interaction.type'],
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
    description: 'Main-process event-loop delay (lateness past the sampling interval), 99th percentile over the last minute',
    attributes: [],
  },
  'clubhouse.process.eventloop.delay.max': {
    kind: 'gauge', unit: 's', level: 'standard',
    description: 'Main-process event-loop delay (lateness past the sampling interval), maximum over the last minute',
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
    description: 'Agent runs that ended, by kind, runtime, orchestrator and exit class',
    attributes: ['clubhouse.agent.kind', 'clubhouse.agent.runtime', 'clubhouse.orchestrator', 'clubhouse.agent.exit.class'],
  },
  'clubhouse.agent.run.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Agent run length, spawn to exit',
    attributes: ['clubhouse.agent.kind', 'clubhouse.agent.runtime', 'clubhouse.orchestrator', 'clubhouse.agent.exit.class'],
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
  'clubhouse.pty.write_rejected': {
    kind: 'counter', unit: '{write}', level: 'errors',
    description: 'PTY writes refused for exceeding the per-call size ceiling',
    attributes: ['clubhouse.pty.write.kind'],
  },
  'clubhouse.pty.stale_swept': {
    kind: 'counter', unit: '{session}', level: 'errors',
    description: 'PTY sessions removed by the stale sweeper because their process was gone',
    attributes: [],
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
  'clubhouse.agent.spawns': {
    kind: 'counter', unit: '{spawn}', level: 'standard',
    description: 'Agent spawn attempts by kind, orchestrator, runtime and outcome',
    attributes: ['clubhouse.agent.kind', 'clubhouse.orchestrator', 'clubhouse.agent.runtime', 'clubhouse.outcome', 'error.type'],
  },
  'clubhouse.agent.spawn.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'spawnAgent entry to process launched',
    attributes: ['clubhouse.agent.kind', 'clubhouse.orchestrator', 'clubhouse.agent.runtime'],
  },
  'clubhouse.group.shoulder_tap.deliveries': {
    kind: 'counter', unit: '{delivery}', level: 'standard',
    description: 'Shoulder tap deliveries by result and target runtime',
    attributes: ['clubhouse.delivery.result', 'clubhouse.agent.runtime'],
  },
  // Annex (§4.12, Phase 6)
  'clubhouse.annex.reconnects': {
    kind: 'counter', unit: '{reconnect}', level: 'standard',
    description: 'Controller reconnect attempts scheduled, by attempt',
    attributes: ['clubhouse.attempt_bucket'],
  },
  'clubhouse.annex.reconnect.delay': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Backoff before a controller reconnect',
    attributes: ['clubhouse.attempt_bucket'],
  },
  'clubhouse.annex.disconnects': {
    kind: 'counter', unit: '{disconnect}', level: 'standard',
    description: 'Controller disconnects from a satellite, by reason',
    attributes: ['clubhouse.annex.disconnect.reason'],
  },
  'clubhouse.annex.heartbeat.rtt': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Controller ping → pong round trip',
    attributes: [],
  },
  'clubhouse.annex.snapshot.build.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Satellite buildSnapshot time',
    attributes: [],
  },
  'clubhouse.annex.snapshots': {
    kind: 'counter', unit: '{snapshot}', level: 'standard',
    description: 'Snapshots the satellite sent or failed to send, by result',
    attributes: ['clubhouse.annex.snapshot.result'],
  },
  'clubhouse.annex.snapshot.bytes': {
    kind: 'histogram', unit: 'By', level: 'standard',
    description: 'Encoded size of a snapshot frame, on connect or refresh',
    attributes: ['clubhouse.annex.snapshot.trigger'],
  },
  'clubhouse.annex.snapshot.icon_bytes': {
    kind: 'histogram', unit: 'By', level: 'standard',
    description: 'Icon data in a snapshot frame, on connect or refresh',
    attributes: ['clubhouse.annex.snapshot.trigger'],
  },
  'clubhouse.annex.snapshot.icons': {
    kind: 'histogram', unit: '{icon}', level: 'standard',
    description: 'Icons in a snapshot frame',
    attributes: [],
  },
  'clubhouse.annex.snapshot.icons_left_out': {
    kind: 'histogram', unit: '{icon}', level: 'standard',
    description: 'Icons a snapshot frame left out for size',
    attributes: [],
  },
  'clubhouse.annex.snapshot.items': {
    kind: 'histogram', unit: '{item}', level: 'standard',
    description: 'Projects and agents listed in a snapshot frame',
    attributes: [],
  },
  'clubhouse.annex.tool_input.requests': {
    kind: 'counter', unit: '{request}', level: 'standard',
    description: 'Permission requests sent to Annex clients, by the size of their input',
    attributes: ['clubhouse.annex.tool_input.bucket'],
  },
  'clubhouse.annex.chat_page.overflow': {
    kind: 'counter', unit: '{page}', level: 'standard',
    description: 'Chat pages whose pending requests had to shrink, or could not be sent',
    attributes: ['clubhouse.annex.chat_page.stage'],
  },
  'clubhouse.annex.frames.over_limit': {
    kind: 'counter', unit: '{frame}', level: 'standard',
    description: 'Frames over the per-frame limit, by type and what was done with them',
    attributes: ['clubhouse.annex.event.type', 'clubhouse.annex.frame.action'],
  },
  'clubhouse.annex.events': {
    kind: 'counter', unit: '{event}', level: 'standard',
    description: 'Events the satellite streamed, per event type (counted once per broadcast, not per client)',
    attributes: ['clubhouse.annex.event.type'],
  },
  'clubhouse.annex.events.bytes': {
    kind: 'counter', unit: 'By', level: 'standard',
    description: 'Serialized bytes of streamed events, per event type and broadcast',
    attributes: ['clubhouse.annex.event.type'],
  },
  'clubhouse.annex.send_failures': {
    kind: 'counter', unit: '{send}', level: 'standard',
    description: 'Per-client WS sends that threw during a broadcast',
    attributes: ['clubhouse.annex.event.type'],
  },
  'clubhouse.annex.clients': {
    kind: 'gauge', unit: '{client}', level: 'standard',
    description: 'WS clients connected to this satellite, by client kind',
    attributes: ['clubhouse.annex.client.kind'],
  },
  'clubhouse.annex.control.denied': {
    kind: 'counter', unit: '{request}', level: 'standard',
    description: 'Control requests refused for lacking mTLS (§12 H9)',
    attributes: ['clubhouse.annex.control.channel'],
  },
  'clubhouse.annex.replays': {
    kind: 'counter', unit: '{replay}', level: 'standard',
    description: 'Event replays requested by reconnecting clients, by result',
    attributes: ['clubhouse.annex.replay.result'],
  },
  // Goobers (§4.13, Phase 6b)
  'clubhouse.goobers.polls': {
    kind: 'counter', unit: '{poll}', level: 'detailed',
    description: 'Goobers liveness poll ticks that ran',
    attributes: [],
  },
  'clubhouse.goobers.poll.skipped': {
    kind: 'counter', unit: '{poll}', level: 'detailed',
    description: 'Poll ticks skipped because the previous one was still running',
    attributes: [],
  },
  'clubhouse.goobers.poll.duration': {
    kind: 'histogram', unit: 's', level: 'detailed',
    description: 'Goobers liveness poll time',
    attributes: [],
  },
  'clubhouse.goobers.data.age': {
    kind: 'gauge', unit: 's', level: 'standard',
    description: 'Seconds since the last fresh payload, per model, sampled at each poll tick (§12 H12)',
    attributes: ['clubhouse.goobers.model'],
  },
  'clubhouse.goobers.sse.reconnects': {
    kind: 'counter', unit: '{reconnect}', level: 'standard',
    description: 'Goobers event-stream drops that went back to reconnecting',
    attributes: [],
  },
  'clubhouse.goobers.sse.terminals': {
    kind: 'counter', unit: '{stream}', level: 'standard',
    description: 'Goobers event streams that stopped for good this lifecycle, by reason',
    attributes: ['clubhouse.sse.terminal_reason'],
  },
  'clubhouse.telemetry.export.failures': {
    kind: 'counter',
    unit: '{export}',
    level: 'errors',
    description: 'Failed exporter batches, by signal, HTTP class and destination kind',
    attributes: ['clubhouse.telemetry.signal', 'clubhouse.http.class', 'clubhouse.telemetry.destination'],
  },
  // Workspace (§4.7–4.10, Phase 5)
  'clubhouse.projects.count': {
    kind: 'gauge', unit: '{project}', level: 'standard',
    description: 'Projects in the project list, sampled once a minute',
    attributes: [],
  },
  'clubhouse.git.status.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'Polled git status (getGitInfo) duration',
    attributes: ['clubhouse.git.status.file_count_bucket'],
  },
  'clubhouse.git.status.polls': {
    kind: 'counter', unit: '{poll}', level: 'standard',
    description: 'Polled git status calls',
    attributes: [],
  },
  'clubhouse.git.subprocess.duration': {
    kind: 'histogram', unit: 's', level: 'standard',
    description: 'git subprocess duration by operation',
    attributes: ['clubhouse.git.op'],
  },
  'clubhouse.file.ops': {
    kind: 'counter', unit: '{op}', level: 'standard',
    description: 'File service operations by result',
    attributes: ['clubhouse.file.op', 'clubhouse.file.result', 'error.type'],
  },
  'clubhouse.file.path_denied': {
    kind: 'counter', unit: '{denial}', level: 'errors',
    description: 'Paths refused by the file sandbox (outside allowed project roots)',
    attributes: [],
  },
  'clubhouse.file_watch.active': {
    kind: 'gauge', unit: '{watch}', level: 'standard',
    description: 'Active file watches, sampled once a minute',
    attributes: [],
  },
  'clubhouse.file_watch.errors': {
    kind: 'counter', unit: '{error}', level: 'errors',
    description: 'File watches that failed to start',
    attributes: ['error.type'],
  },
  'clubhouse.plugin.protocol.requests': {
    kind: 'counter', unit: '{request}', level: 'standard',
    description: 'clubhouse-plugin: module requests by result',
    attributes: ['clubhouse.plugin.protocol.result'],
  },
  // Workspace 5b
  'clubhouse.group.bulletin.posts': {
    kind: 'counter', unit: '{post}', level: 'standard',
    description: 'Bulletin posts by result, from any source (MCP or UI)',
    attributes: ['clubhouse.bulletin.post.result'],
  },
} as const satisfies Record<string, MetricDef>;
export type MetricName = keyof typeof METRICS;

export interface EventDef {
  readonly level: TelemetryLevel;
  /**
   * An audit event (#2920): local recording keeps it at every level and outside
   * the hourly event cap, since it's the record of who changed what. Export still
   * follows `level`.
   */
  readonly audit?: true;
}

export const EVENTS = {
  /** Failed chat handshake; only driver and bounded error.type, never stderr or env. */
  'clubhouse.chat.probe_failed': { level: 'errors' },
  /**
   * A chat start left a driver: for the next one, or for the terminal (#2304).
   * Attributes: driver, orchestrator, `clubhouse.chat.fallback.to`,
   * `clubhouse.chat.start.reason`, `error.type`, version status, timings.
   */
  'clubhouse.chat.fallback': { level: 'standard' },
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
  /**
   * A burst of renderer frames over the hang threshold (#2126), one per coalesced burst.
   * Attributes: view, surface, `clubhouse.ui.hang.duration_ms`, `.frames`, `.script_source`, `clubhouse.ui.interaction.type`.
   */
  'clubhouse.ui.hang': { level: 'standard' },
  /**
   * A burst of interactions over the same threshold, input to next paint (#2307). Shares
   * `clubhouse.ui.hang`'s coalescing and six-a-minute cap. Attributes: view, surface,
   * `clubhouse.ui.slow_interaction.duration_ms`, `.count`, `clubhouse.ui.interaction.type`.
   * The target id stays in the local `ui:perf` line.
   */
  'clubhouse.ui.slow_interaction': { level: 'standard' },
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
  /** This install's Annex identity was regenerated: paired peers will no longer trust it (§12 H9). */
  'clubhouse.annex.identity.regenerated': { level: 'errors' },
  /** The satellite could not set up TLS and serves plain HTTP (security-relevant, §4.12). */
  'clubhouse.annex.tls_fallback': { level: 'errors' },
  /** Goobers liveness changed (daemon state, connection or error code). Only on transitions. */
  'clubhouse.goobers.liveness': { level: 'standard' },
  /** The Goobers event stream changed mode (live / reconnecting / polling / unavailable). */
  'clubhouse.goobers.stream.mode': { level: 'standard' },
  /** A store hit corruption or fell back to a backup (§12 H1). Silent today; always worth knowing. */
  'clubhouse.persist.recovery': { level: 'errors' },
  /** A data-loss guard blocked saves. Sent once per store and reason per session. */
  'clubhouse.persist.guard_blocked': { level: 'errors' },
  // Workspace (§4.7–4.10, Phase 5)
  /** A file changed on disk while its editor tab had unsaved edits. */
  'clubhouse.editor.save_conflict': { level: 'errors' },
  // Workspace 5b: settings and feature usage (§4.14), main-process call sites only.
  /** Attributes: `clubhouse.settings.key`. Never values. */
  'clubhouse.settings.changed': { level: 'standard' },
  /**
   * start_helper decided a helper's CLI, model and effort (#2671). Attributes:
   * the requested CLI, difficulty, mode, resolved `orchestrator`, `modelFamily`,
   * effort, preset, config source, reason, fallback and policy version.
   */
  'clubhouse.helper.routed': { level: 'standard' },
  // Helper decisions, outcomes and usage (#2747). Recorded locally at the default level and written with `localOnly`: never exported.
  /** One routing decision, accepted or refused. Attributes: decision and agent id hashes, mode, orchestrator, model hash and family, effort, task profile, mapping hashes, thresholds, counts, tie fields. */
  'clubhouse.helper.decision': { level: 'standard' },
  /** Shadow forecast error against a whole-login interval, never attributed per-helper consumption. Local only. */
  'clubhouse.helper.forecast': { level: 'standard' },
  /** One provider as a decision saw it. Attributes: decision id hash, orchestrator, eligibility, exclusion, load, quota, score. */
  'clubhouse.helper.decision.candidate': { level: 'standard' },
  /** What became of a decision: started, left asleep, failed, refused, cancelled. */
  'clubhouse.helper.spawn_result': { level: 'standard' },
  /** A wake or resume of an existing helper, joined to its earlier decision. Never a new decision. */
  'clubhouse.helper.reuse': { level: 'standard' },
  /** A helper run's usage after a finished turn, or its closing figure. Absent figures are unavailable. */
  'clubhouse.helper.usage.sample': { level: 'standard' },
  /** A helper run ended (or the helper was disposed), with the errors the session saw. */
  'clubhouse.helper.outcome': { level: 'standard' },
  /** A provider's plan-limit reading, on first read, a state or window change, or a bounded interval. Token-free. */
  'clubhouse.helper_quota.sample': { level: 'standard' },
  /** Helper presets were changed or reset, or a change was refused. Attributes: action, surface, `clubhouse.outcome`. */
  'clubhouse.helper_routing.changed': { level: 'standard' },
  /** `cli: "auto"` was refused. Attributes: the refusal's code. */
  'clubhouse.helper_auto.refused': { level: 'standard' },
  /** Auto is leaving a provider alone for a while after a failure. Attributes: `orchestrator`, the class. */
  'clubhouse.helper_auto.cooling': { level: 'standard' },
  /** A CLI's plan limits were read, token-free. Attributes: `orchestrator`, the state, `clubhouse.outcome`. */
  'clubhouse.helper_quota.read': { level: 'standard' },
  /** Attributes: `clubhouse.theme.kind`, `clubhouse.theme.builtin_id`. */
  'clubhouse.theme.changed': { level: 'standard' },
  /** Attributes: `clubhouse.popout.type`. */
  'clubhouse.popout.opened': { level: 'standard' },
  /** Attributes: `clubhouse.outcome`. */
  'clubhouse.blueprint.exported': { level: 'standard' },
  'clubhouse.blueprint.imported': { level: 'standard' },
  /** An agent listed its MCP tools (§12 H8). Attributes: tool-count bucket, empty flag. */
  'clubhouse.mcp.tools_list': { level: 'standard' },
  // appLog bridge (§6.6, Phase 7): opt-in log sites, exported as these events
  // with their declared attributes only, never the message or meta.
  /**
   * Annex controller: a satellite stopped answering heartbeats. The Errors-level
   * signal; `clubhouse.annex.disconnects{reason}` is the Standard-level breakdown.
   */
  'clubhouse.annex.heartbeat_timeout': { level: 'errors' },
  /** A permission request still pending past the stuck threshold. Attributes: `clubhouse.agent.id_hash`. */
  'clubhouse.agent.permission.stuck': { level: 'errors' },
  /** Restoring an agent's config file from its snapshot failed. Attributes: `clubhouse.config.format`. */
  'clubhouse.config.restore_failed': { level: 'errors' },
  // Feedback (#2309). The report id goes on `submitted` for the developer destination only (#2524).
  /** Screenshots taken for a review. Attributes: screenshot, shots, windows, trigger. */
  'clubhouse.feedback.captured': { level: 'standard' },
  /** Reviewed feedback saved to the outbox. Attributes: screenshot, annotated, shots, access state, and the report id for the developer destination only (#2524). */
  'clubhouse.feedback.submitted': { level: 'standard' },
  /** The outbox delivered a report (Framebriar's receipt). */
  'clubhouse.feedback.delivered': { level: 'standard' },
  /** A feedback step failed. Attributes: `clubhouse.feedback.stage`, `clubhouse.feedback.error`. */
  'clubhouse.feedback.failed': { level: 'errors' },
  /** An invitation was accepted. */
  'clubhouse.feedback.connected': { level: 'standard' },
  /** Access changed to a settled state (in-between states are left out). Attributes: state, from, notice. */
  'clubhouse.feedback.access': { level: 'standard' },
  /** A feedback request was refused before any capture. Attributes: `clubhouse.feedback.refusal`. */
  'clubhouse.feedback.request_refused': { level: 'standard' },
  // Session-id capture and resume (#2305)
  /**
   * A durable run ended and its session id was saved, kept or rejected.
   * Attributes: orchestrator, `clubhouse.agent.id_hash`, `clubhouse.agent.runtime`,
   * capture result and source, `process.exit.code`.
   */
  'clubhouse.agent.session_capture': { level: 'standard' },
  /** A saved resume id was cleared because its session is gone. Attributes: orchestrator, agent id hash, stale reason. */
  'clubhouse.agent.session_stale_cleared': { level: 'errors' },
  /**
   * The resume outcome of a durable wake, per provider: at chat session open,
   * or at a terminal run's exit. Attributes: orchestrator, agent id hash,
   * `clubhouse.agent.runtime`, resume result.
   */
  'clubhouse.agent.resume_outcome': { level: 'standard' },
  // Actions (#2918, #2956). Every event carries `clubhouse.action.owner`; Clubhouse's own hidden actions report `app`.
  /** A trigger fired. Attributes: trigger kind, and for event triggers the event kind and whether it waits first. */
  'clubhouse.action.triggered': { level: 'standard' },
  /** A delayed event trigger's wait started, restarted, was cancelled, fired, or was dropped at launch. Attributes: wait code, event kind. */
  'clubhouse.action.wait': { level: 'standard' },
  /** A trigger fired while the last run was still going. Attributes: overlap code (skipped, queued), trigger kind. */
  'clubhouse.action.overlap': { level: 'standard' },
  /** Loop protection or the hourly limit stopped a run. Attributes: limit code, chain depth bucket. */
  'clubhouse.action.limit_hit': { level: 'standard' },
  /** Schedule times were missed while Clubhouse was closed or asleep. Attributes: missed-count bucket, the action's missed-run rule. */
  'clubhouse.action.catch_up': { level: 'standard' },
  /** A run ended or was recorded without running. Attributes: outcome, reason code, trigger, step count, failed step kind, chain depth bucket, duration. */
  'clubhouse.action.run': { level: 'standard' },
  /** One step of a run. Attributes: step kind, outcome, position (1 to 3). */
  'clubhouse.action.step': { level: 'standard' },
  /**
   * The same run, with the action id hash (and the owning agent's id hash for agent-owned actions).
   * Detailed: recorded locally only at the Detailed level, and exported only to destinations set to Detailed.
   */
  'clubhouse.action.run_detail': { level: 'detailed' },
  /**
   * A settings change or refusal, from any surface (#2920, was settings-audit.jsonl). Attributes:
   * surface, scope, outcome, actor and target id hashes. The local record's detail adds the key,
   * the old and new value when they're keepable (else `changed`), and the refusal code.
   */
  'clubhouse.audit.setting': { level: 'standard', audit: true },
  /**
   * One Dispatcher control call, refusals included (#2920, was dispatcher-audit.jsonl). Attributes:
   * tool, outcome, actor and first target id hashes. The local record's detail adds every target's
   * hash, what was requested, before and after, and the code. `list_orchestrator_controls` reads these back.
   */
  'clubhouse.audit.dispatcher_control': { level: 'standard', audit: true },
  /**
   * A Clubhouse MCP call the permissions refused or asked the user about (#2973). Attributes: action,
   * decision, refusal reason, target kind, the caller's id hash. Detail: the tool (its built-in name or
   * suffix only), and `actions` when there are several. Asked: only when a new request goes to the user. Allowed calls aren't events: the
   * `clubhouse.mcp.tool_call` span already counts every call.
   */
  'clubhouse.audit.grant_decision': { level: 'standard', audit: true },
  /** The user's answer to a permission request, or its expiry (#2973). Attributes: kind, outcome, action, the asking agent's id hash. Detail: the request kind and actions. */
  'clubhouse.audit.grant_request': { level: 'standard', audit: true },
  /**
   * A change to an agent's Clubhouse permissions or a connection's (#2973). Attributes: surface, layer,
   * mode, action (absent for a reset or a connection), the actor's and the agent's id hashes. Detail:
   * the target kind, and for a connection the disabled tools and the other end's id hash.
   */
  'clubhouse.audit.grant_change': { level: 'standard', audit: true },
  // Dispatcher (#3052). Counts, sizes and closed codes only (spec §4.18).
  /**
   * One finished Dispatcher turn. Attributes: `clubhouse.dispatcher.work` (conversations or background),
   * whether usage was reported, the turn's token counts and cost in micro-dollars, `clubhouse.cost.estimate`.
   */
  'clubhouse.dispatcher.turn': { level: 'standard' },
  /**
   * Memory health after each upkeep run: page counts and bytes, the index's bytes against its cap,
   * unlinked, stale and unconfirmed topics, broken links and missing sources.
   */
  'clubhouse.dispatcher.memory_health': { level: 'standard' },
  /** What one memory upkeep run did: days and weeks rolled, links fixed, topics pruned, pages to check, whether a review was asked for, `clubhouse.outcome`. */
  'clubhouse.dispatcher.memory_upkeep': { level: 'standard' },
  /** One report on its way to the Dispatcher's chat: its kind, what triage did and why, whether it was an agent's, held items a check-in took, and the rewrite outcome. */
  'clubhouse.dispatcher.news_triage': { level: 'standard' },
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
