import { deriveAcpCapabilities, type AcpDriverCapabilities } from './acp-capabilities';
import { GENERIC_ACP_PROFILE, type AcpAgentProfile, type AcpPermissionLevels } from './acp-session';
import type { PermissionLevel } from '../../../shared/chat/capabilities';
import type {
  InitializeResponse,
  LegacySessionModelState,
  Meta,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionUpdate,
} from './acp-schema';
import { resolveStructuredSpawn, type StructuredSpawnCommand } from './structured-spawn';

/**
 * Copilot CLI over ACP (`copilot --acp`), public preview.
 *
 * Facts below were probed against Copilot CLI 1.0.92 (live ACP transcripts,
 * committed as fixtures) and re-checked against 1.0.98's `--help`. See
 * docs/structured-chat-research.md §3.
 */

/**
 * - `--acp --stdio`: ACP over stdio (stdio is the default; `--stdio` is
 *   accepted though hidden from `--help`, and keeps us off `--port`).
 * - `--no-auto-update`: the brew/winget shim otherwise runs a newer cached
 *   package, so the version the handshake reports could change between runs.
 */
export const COPILOT_ACP_ARGS: readonly string[] = ['--acp', '--stdio', '--no-auto-update'];

/** Versions whose ACP behaviour the fixtures and probes cover. Newer is "untested", not broken. */
export const COPILOT_ACP_TESTED_RANGE = { min: '1.0.92', max: '1.0.98' } as const;

/** Copilot's ACP mode ids are URIs ending in one of these fragments. */
export type CopilotModeKind = 'agent' | 'plan' | 'autopilot';

export interface CopilotAcpLaunchOptions {
  binary: string;
  /**
   * Extra CLI flags. Permission rules (`--allow-tool`, `--deny-tool`,
   * `--available-tools`…) and `--reasoning-effort` can only be set here:
   * Copilot applies them server-wide and offers no per-session equivalent.
   */
  extraArgs?: string[];
  commandPrefix?: string;
}

export function resolveCopilotAcpSpawn(opts: CopilotAcpLaunchOptions): StructuredSpawnCommand {
  return resolveStructuredSpawn(opts.binary, [...COPILOT_ACP_ARGS, ...(opts.extraArgs ?? [])], opts.commandPrefix);
}

export function isCopilotAgent(init: InitializeResponse): boolean {
  return /^copilot$/i.test(init.agentInfo?.name ?? '');
}

export function copilotModeKind(modeId: string): CopilotModeKind | undefined {
  const fragment = modeId.slice(modeId.lastIndexOf('#') + 1);
  return fragment === 'agent' || fragment === 'plan' || fragment === 'autopilot' ? fragment : undefined;
}

export function copilotVersionStatus(version: string | undefined): 'tested' | 'newer' | 'older' | 'unknown' {
  if (!version || !parseVersion(version)) return 'unknown';
  if (compareVersions(version, COPILOT_ACP_TESTED_RANGE.min) < 0) return 'older';
  if (compareVersions(version, COPILOT_ACP_TESTED_RANGE.max) > 0) return 'newer';
  return 'tested';
}

// ── Model-list dedupe ────────────────────────────────────────────────────────

/**
 * Copilot lists every model twice: a bare entry and one carrying cost
 * `_meta` (`copilotUsage`, `copilotPriceCategory`). Keep one per value, at the
 * first entry's position, preferring the entry with more metadata.
 */
export function dedupeByKey<T>(items: T[], key: (item: T) => string, meta: (item: T) => Meta | undefined): T[] {
  const index = new Map<string, number>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push(item);
    } else if (metaWeight(meta(item)) > metaWeight(meta(out[at]))) {
      out[at] = item;
    }
  }
  return out;
}

function metaWeight(meta: Meta | undefined): number {
  return meta ? Object.values(meta).filter((v) => v !== null && v !== undefined).length : 0;
}

function isGroupedOptions(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]): options is SessionConfigSelectGroup[] {
  return options.length > 0 && 'group' in options[0];
}

function dedupeSelectOptions(options: SessionConfigSelectOption[]): SessionConfigSelectOption[] {
  return dedupeByKey(options, (o) => o.value, (o) => o._meta);
}

export function dedupeCopilotConfigOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  return options.map((option) => {
    if (option.type !== 'select' || !Array.isArray(option.options)) return option;
    const deduped = isGroupedOptions(option.options)
      ? option.options.map((g) => ({ ...g, options: dedupeSelectOptions(g.options) }))
      : dedupeSelectOptions(option.options);
    return { ...option, options: deduped };
  });
}

export function dedupeCopilotLegacyModels(models: LegacySessionModelState): LegacySessionModelState {
  return { ...models, availableModels: dedupeByKey(models.availableModels, (m) => m.modelId, (m) => m._meta) };
}

// ── Stray TUI text ───────────────────────────────────────────────────────────

/** `Info: /abs/path` (or `Info: C:\…`) printed into the assistant stream after an edit tool. */
const STRAY_INFO_RE = /^Info: (?:\/|[A-Za-z]:[\\/])\S*\s*$/;

/**
 * Drop the `Info: <path>` line Copilot leaks into `agent_message_chunk` while
 * an edit tool is running. Only a whole chunk that is exactly that line, with
 * a tool call still open, is dropped, so real assistant prose is never lost.
 */
export function filterCopilotUpdate(update: SessionUpdate, ctx: { openToolCallIds: ReadonlySet<string> }): SessionUpdate | null {
  if (
    update.sessionUpdate === 'agent_message_chunk'
    && update.content.type === 'text'
    && ctx.openToolCallIds.size > 0
    && STRAY_INFO_RE.test(update.content.text)
  ) {
    return null;
  }
  return update;
}

// ── Capability record ────────────────────────────────────────────────────────

export function copilotAcpCapabilities(init: InitializeResponse): AcpDriverCapabilities {
  const base = deriveAcpCapabilities(init, 'copilot');
  const versionStatus = copilotVersionStatus(init.agentInfo?.version);
  return {
    ...base,
    // `session/load` replays user/agent messages and tool calls (not thoughts).
    // `session/resume`, `fork`, `delete` and `$/cancel_request` answer -32601.
    resume: base.resume === 'resume' ? 'resume' : 'load',
    deleteSession: false,
    listIsMachineWide: true,
    // Subagent ids appear since 1.0.81, format unverified.
    subagents: 'unverified',
    // No reject_always; "always" scope is Copilot's and isn't described.
    permissionOptionKinds: ['allow_once', 'allow_always', 'reject_once'],
    permissionRules: 'launch_only',
    // usage_update carries context fill only; token totals come on the prompt result.
    usage: { context: true, turnTokens: true, cost: false },
    // Commands run as prompt text; ones that open a TUI picker don't work.
    interactiveSlashCommands: false,
    // Copilot does its own file I/O even when fs/* is advertised.
    clientFs: false,
    quirks: [
      'model-list-duplicates',
      'stray-info-line',
      'reasoning-token-per-chunk',
      'mode-ids-are-uris',
      'allow-all-is-a-config-option',
      ...(versionStatus === 'newer' ? ['untested-version'] : []),
      ...(versionStatus === 'older' ? ['below-tested-version'] : []),
    ],
  };
}

// ── Permission ladder ────────────────────────────────────────────────────────

const COPILOT_MODE_BASE = 'https://agentclientprotocol.com/protocol/session-modes#';

/**
 * Copilot over ACP has two knobs: the mode (agent / plan / autopilot) and the
 * `allow_all` config option. That covers Plan, Ask first and Full access.
 * There is no "accept edits only" or classifier mode, so Auto-accept edits
 * and Auto aren't offered. Autopilot (experimental, runs until done without
 * user input) reads as Full access but is never chosen by Clubhouse.
 */
export const COPILOT_PERMISSION_LEVELS: AcpPermissionLevels = {
  live: ['plan', 'ask', 'full_access'],
  current(state) {
    const mode = state.modes?.currentModeId ?? stringOption(state.configOptions, 'mode');
    const kind = mode ? copilotModeKind(mode) : undefined;
    if (kind === 'plan') return 'plan';
    if (kind === 'autopilot') return 'full_access';
    if (kind === 'agent') return stringOption(state.configOptions, 'allow_all') === 'on' ? 'full_access' : 'ask';
    return undefined;
  },
  async apply(session, level: PermissionLevel) {
    if (!COPILOT_PERMISSION_LEVELS.live.includes(level)) {
      throw new Error(`Copilot over ACP has no ${level} level`);
    }
    const state = session.getState();
    const targetMode = COPILOT_MODE_BASE + (level === 'plan' ? 'plan' : 'agent');
    const modeId = state.modes?.availableModes.find((m) => copilotModeKind(m.id) === copilotModeKind(targetMode))?.id ?? targetMode;
    const allowAll = level === 'full_access' ? 'on' : 'off';
    if (stringOption(state.configOptions, 'allow_all') !== allowAll && state.configOptions.some((o) => o.id === 'allow_all')) {
      await session.setConfigOption('allow_all', allowAll);
    }
    if ((state.modes?.currentModeId ?? stringOption(state.configOptions, 'mode')) !== modeId) {
      await session.setMode(modeId);
    }
  },
};

function stringOption(options: SessionConfigOption[], id: string): string | undefined {
  const option = options.find((o) => o.id === id);
  return option?.type === 'select' ? option.currentValue : undefined;
}

export const COPILOT_ACP_PROFILE: AcpAgentProfile = {
  id: 'copilot',
  capabilities: copilotAcpCapabilities,
  normalizeConfigOptions: dedupeCopilotConfigOptions,
  normalizeLegacyModels: dedupeCopilotLegacyModels,
  filterUpdate: filterCopilotUpdate,
  permissionLevels: COPILOT_PERMISSION_LEVELS,
};

/** Pick the profile from the handshake: Copilot's when it is Copilot, else generic. */
export function selectAcpProfile(init: InitializeResponse): AcpAgentProfile {
  return isCopilotAgent(init) ? COPILOT_ACP_PROFILE : GENERIC_ACP_PROFILE;
}

// ── Versions ─────────────────────────────────────────────────────────────────

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
