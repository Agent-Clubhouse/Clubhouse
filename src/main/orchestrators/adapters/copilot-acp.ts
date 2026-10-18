import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveAcpCapabilities, type AcpDriverCapabilities } from './acp-capabilities';
import { GENERIC_ACP_PROFILE, type AcpAgentProfile, type AcpPermissionLevels, type AcpTask } from './acp-session';
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
 * Facts below come from live ACP transcripts of Copilot CLI 1.0.92 and 1.0.98
 * (committed as fixtures) and 1.0.98's `--help`. See
 * docs/structured-chat-research.md §3.
 */

/**
 * `--acp --stdio`: ACP over stdio (stdio is the default; `--stdio` is accepted
 * though hidden from `--help`, and keeps us off `--port`).
 *
 * No `--no-auto-update` (#2154). With it, the Homebrew/WinGet shim ignores the
 * newer package the user has already downloaded and runs the runtime bundled
 * in the shim (1.0.82 while the user's terminal runs 1.0.98), so chat and
 * Terminal would run different Copilots. Without it, chat runs exactly what
 * `copilot` runs. Auto-update only changes what the next launch picks; a
 * running process keeps its version, so a session can't change under us.
 */
export const COPILOT_ACP_ARGS: readonly string[] = ['--acp', '--stdio'];

/**
 * Versions whose ACP behaviour the fixtures and probes cover: 1.0.82 (a
 * recorded handshake, test/chat-fixtures/copilot/handshake-1.0.82.jsonl, from
 * the shim's bundled runtime), 1.0.92 and 1.0.98. Newer is "untested", not
 * broken.
 */
export const COPILOT_ACP_TESTED_RANGE = { min: '1.0.82', max: '1.0.98' } as const;

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
  names: { plan: 'Plan', ask: 'Agent', full_access: 'Agent, allow all' },
  current(state) {
    const mode = state.modes?.currentModeId ?? stringOption(state.configOptions, 'mode');
    const kind = mode ? copilotModeKind(mode) : undefined;
    if (kind === 'plan') return 'plan';
    if (kind === 'autopilot') return 'full_access';
    if (kind === 'agent') return stringOption(state.configOptions, 'allow_all') === 'on' ? 'full_access' : 'ask';
    return undefined;
  },
  async apply(session, level: PermissionLevel, opts) {
    if (!COPILOT_PERMISSION_LEVELS.live.includes(level)) {
      throw new Error(`Copilot over ACP has no ${level} level`);
    }
    const state = session.getState();
    const targetMode = COPILOT_MODE_BASE + (level === 'plan' ? 'plan' : 'agent');
    const modeId = state.modes?.availableModes.find((m) => copilotModeKind(m.id) === copilotModeKind(targetMode))?.id ?? targetMode;
    const allowAll = level === 'full_access' ? 'on' : 'off';
    // `force` (after a resume) sends both even when the reported options
    // match: a loaded session reports the old process's allow_all, which the
    // new process may not be honouring, and Full access then prompts for every
    // tool (#2155).
    const force = !!opts?.force;
    if (state.configOptions.some((o) => o.id === 'allow_all') && (force || stringOption(state.configOptions, 'allow_all') !== allowAll)) {
      await session.setConfigOption('allow_all', allowAll);
    }
    const currentMode = state.modes?.currentModeId ?? stringOption(state.configOptions, 'mode');
    if ((state.modes || state.configOptions.some((o) => o.category === 'mode')) && (force || currentMode !== modeId)) {
      await session.setMode(modeId);
    }
  },
};

function stringOption(options: SessionConfigOption[], id: string): string | undefined {
  const option = options.find((o) => o.id === id);
  return option?.type === 'select' ? option.currentValue : undefined;
}

/** Copilot's model options carry the legacy premium-request multiplier ("0.33x", "1x", …). */
export function copilotModelCostHint(meta: Meta | undefined): string | undefined {
  const usage = meta?.copilotUsage;
  return typeof usage === 'string' && usage ? usage : undefined;
}

// ── Native session lookup ────────────────────────────────────────────────────

/**
 * Where Copilot keeps its sessions: `$COPILOT_HOME/session-state`, defaulting
 * to `~/.copilot/session-state` (the user's home on Windows too).
 */
export function copilotSessionStateDir(env: Record<string, string | undefined>): string {
  const home = env.COPILOT_HOME || env.GH_COPILOT_CONFIG_DIR || path.join(os.homedir(), '.copilot');
  return path.join(home, 'session-state');
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Copilot answers session/load for a session it doesn't have by hanging, not
 * with an error (#2155), so look on disk first. Ids that aren't a plain
 * token can't be Copilot's and are never used as a path.
 */
export async function copilotNativeSessionExists(sessionId: string, env: Record<string, string | undefined>): Promise<boolean | undefined> {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  try {
    await fs.promises.stat(path.join(copilotSessionStateDir(env), sessionId));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
}

// ── Plan mode (#2176) ────────────────────────────────────────────────────────

/** In plan mode Copilot writes its plan to `<config>/session-state/<sessionId>/plan.md`. */
const COPILOT_PLAN_FILE_RE = /[\\/]session-state[\\/][A-Za-z0-9_-]+[\\/]plan\.md$/;

export function copilotPlanFilePath(paths: readonly string[]): string | undefined {
  return paths.find((p) => COPILOT_PLAN_FILE_RE.test(p));
}

/** Copilot's todo statuses → task statuses. */
function taskStatus(raw: string | undefined): AcpTask['status'] {
  const s = (raw ?? '').toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active') return 'in_progress';
  return 'pending';
}

/** SQL values from one `( … )` tuple: quoted strings ('' escapes), numbers, NULL. */
function sqlValues(tuple: string): Array<string | null> {
  const out: Array<string | null> = [];
  const re = /'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(NULL)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tuple))) out.push(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ?? null);
  return out;
}

/** The `( … )` groups after VALUES, respecting quotes. */
function sqlTuples(values: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    const c = values[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === '(' && depth++ === 0) start = i + 1;
    else if (c === ')' && --depth === 0 && start >= 0) tuples.push(values.slice(start, i));
  }
  return tuples;
}

/**
 * Copilot stores plan todos with its `sql` tool, e.g.
 * `INSERT OR REPLACE INTO todos (id, title, description, status) VALUES (…), …`
 * and `UPDATE todos SET status = 'done' WHERE id = '…'`. Applies the
 * statements that touch `todos` to the current list; anything else (other
 * tables, SELECTs) is no change.
 */
export function copilotTasksAfterToolCall(rawInput: unknown, current: readonly AcpTask[]): AcpTask[] | undefined {
  const query = rawInput && typeof rawInput === 'object' ? (rawInput as { query?: unknown }).query : undefined;
  if (typeof query !== 'string' || !/\btodos\b/i.test(query)) return undefined;
  const tasks = new Map(current.map((t) => [t.id, { ...t }]));
  let changed = false;
  for (const statement of query.split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)) {
    const insert = /^\s*(?:INSERT|REPLACE)\b[^(]*?\binto\s+todos\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(statement);
    if (insert) {
      const cols = insert[1].split(',').map((c) => c.trim().replace(/["`]/g, '').toLowerCase());
      for (const tuple of sqlTuples(insert[2])) {
        const row = Object.fromEntries(cols.map((c, i) => [c, sqlValues(tuple)[i]]));
        const id = row.id ?? row.title;
        if (!id) continue;
        tasks.set(id, { id, content: row.title ?? row.description ?? id, status: taskStatus(row.status ?? undefined) });
        changed = true;
      }
      continue;
    }
    const update = /^\s*UPDATE\s+todos\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(statement);
    if (update) {
      const status = /\bstatus\s*=\s*'([^']*)'/i.exec(update[1])?.[1];
      const title = /\btitle\s*=\s*'((?:[^']|'')*)'/i.exec(update[1])?.[1]?.replace(/''/g, "'");
      const ids = /\bid\s+IN\s*\(([^)]*)\)/i.exec(update[2])
        ? sqlValues(/\bid\s+IN\s*\(([^)]*)\)/i.exec(update[2])![1]).filter((v): v is string => !!v)
        : [/\bid\s*=\s*'([^']*)'/i.exec(update[2])?.[1]].filter((v): v is string => !!v);
      for (const id of ids) {
        const task = tasks.get(id);
        if (!task) continue;
        if (status !== undefined) task.status = taskStatus(status);
        if (title !== undefined) task.content = title;
        changed = true;
      }
      continue;
    }
    const del = /^\s*DELETE\s+FROM\s+todos\b(?:\s+WHERE\s+([\s\S]*))?$/i.exec(statement);
    if (del) {
      if (!del[1]) tasks.clear();
      else for (const id of sqlValues(del[1]).filter((v): v is string => !!v)) tasks.delete(id);
      changed = true;
    }
  }
  return changed ? [...tasks.values()] : undefined;
}

export const COPILOT_ACP_PROFILE: AcpAgentProfile = {
  id: 'copilot',
  planFilePath: copilotPlanFilePath,
  tasksAfterToolCall: copilotTasksAfterToolCall,
  // usage_update.size is Copilot's input budget (e.g. 272k of a 400k window, #2178).
  contextWindow: 'input',
  nativeSessionExists: copilotNativeSessionExists,
  modelCostHint: copilotModelCostHint,
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
