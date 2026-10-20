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
    // 1.0.98 drops client stdio servers with "Rejecting non-http/sse MCP
    // server" despite ACP's stdio baseline (#2240). Only http/sse get through.
    mcp: { ...base.mcp, stdio: false },
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
 * to `~/.copilot/session-state` (the user's home on Windows too). A leading
 * `~` is expanded and blanks are ignored, as `resolveCopilotHome` does for the
 * terminal path: a profile's `COPILOT_HOME=~/x` must not make every session
 * look missing (#2296).
 */
export function copilotSessionStateDir(env: Record<string, string | undefined>): string {
  const configured = [env.COPILOT_HOME, env.GH_COPILOT_CONFIG_DIR]
    .map((v) => v?.trim())
    .find((v): v is string => !!v);
  return path.join(expandHome(configured) ?? path.join(os.homedir(), '.copilot'), 'session-state');
}

function expandHome(p: string | undefined): string | undefined {
  if (p === '~') return os.homedir();
  if (p?.startsWith('~/') || p?.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
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

function samePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/**
 * In plan mode Copilot writes its plan to `<session-state>/<sessionId>/plan.md`,
 * where the directory is the ACP session id. Only that file is this session's
 * plan: a workspace `plan.md` or another session's plan is an ordinary edit.
 */
export function copilotPlanFilePath(
  paths: readonly string[],
  ctx: { sessionId: string | null; env: Record<string, string | undefined> },
): string | undefined {
  if (!ctx.sessionId || !SESSION_ID_RE.test(ctx.sessionId)) return undefined;
  const planFile = samePath(path.join(copilotSessionStateDir(ctx.env), ctx.sessionId, 'plan.md'));
  return paths.find((p) => path.isAbsolute(p) && samePath(p) === planFile);
}

/** Copilot's todo statuses → task statuses. */
function taskStatus(raw: string | undefined): AcpTask['status'] {
  const s = (raw ?? '').toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active') return 'in_progress';
  return 'pending';
}

/**
 * `sql` with quoted text and parenthesised text blanked out (same length), so
 * keywords, commas and `;` can be found at the top level with plain regexes.
 */
function sqlMask(sql: string): string {
  let out = '';
  let quote = '';
  let depth = 0;
  // By UTF-16 unit, so the mask lines up with the original's indexes.
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c === quote ? c : '_';
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
    } else if (c === '(') {
      out += depth++ === 0 ? c : '_';
    } else if (c === ')' && depth > 0) {
      out += --depth === 0 ? c : '_';
    } else {
      out += depth > 0 ? '_' : c;
    }
  }
  return out;
}

/** Splits `sql` at top-level matches of `sep` (quotes and parens respected). */
function sqlSplit(sql: string, sep: RegExp): string[] {
  const masked = sqlMask(sql);
  const parts: string[] = [];
  let start = 0;
  const re = new RegExp(sep.source, sep.flags.includes('g') ? sep.flags : `${sep.flags}g`);
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (!m[0]) { re.lastIndex++; continue; }
    parts.push(sql.slice(start, m.index));
    start = m.index + m[0].length;
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A quoted SQL string ('' escapes) or a number, as text; NULL as null; else undefined. */
function sqlLiteral(expr: string): string | null | undefined {
  const e = expr.trim();
  const quoted = /^'((?:[^']|'')*)'$/.exec(e);
  if (quoted) return quoted[1].replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(e)) return e;
  if (/^NULL$/i.test(e)) return null;
  return undefined;
}

/** The `( … )` contents of a top-level parenthesised list, or undefined. */
function sqlParenList(expr: string): string[] | undefined {
  const m = /^\(([\s\S]*)\)$/.exec(expr.trim());
  return m ? sqlSplit(m[1], /,/) : undefined;
}

/** A todo row as a statement sees it. Statuses compare by meaning ('done' = 'completed'). */
type TodoRow = AcpTask;
type TodoColumn = 'id' | 'title' | 'status';
const COLUMN = /^["`]?(id|title|status)["`]?$/i;

function columnOf(expr: string): TodoColumn | undefined {
  return COLUMN.exec(expr.trim())?.[1].toLowerCase() as TodoColumn | undefined;
}

function rowValue(row: TodoRow, col: TodoColumn): string {
  return col === 'title' ? row.content : row[col];
}

function sameValue(col: TodoColumn, rowValue: string, literal: string): boolean {
  return col === 'status' ? taskStatus(literal) === rowValue : rowValue === literal;
}

function likeRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * A WHERE predicate over id/title/status: `=`, `!=`/`<>`, `[NOT] IN (…)` and
 * `LIKE`, joined by AND. Anything else is undefined: the statement is skipped
 * rather than guessed at.
 */
function sqlPredicate(where: string): ((row: TodoRow) => boolean) | undefined {
  const atoms = sqlSplit(where, /\s+AND\s+/i).map((atom): ((row: TodoRow) => boolean) | undefined => {
    if (/\bOR\b/i.test(sqlMask(atom))) return undefined;
    const m = /^(\S+?)\s*(=|!=|<>|\s+NOT\s+IN\s*|\s+IN\s*|\s+LIKE\s+)([\s\S]+)$/i.exec(atom.trim());
    const col = m && columnOf(m[1]);
    if (!m || !col) return undefined;
    const op = m[2].trim().toUpperCase().replace(/\s+/g, ' ');
    if (op === 'IN' || op === 'NOT IN') {
      const values = sqlParenList(m[3])?.map(sqlLiteral);
      if (!values || values.some((v) => typeof v !== 'string')) return undefined;
      const negate = op === 'NOT IN';
      return (row) => (values as string[]).some((v) => sameValue(col, rowValue(row, col), v)) !== negate;
    }
    const literal = sqlLiteral(m[3]);
    if (typeof literal !== 'string') return undefined;
    if (op === 'LIKE') {
      const re = likeRegExp(literal);
      return (row) => re.test(rowValue(row, col));
    }
    return op === '=' ? (row) => sameValue(col, rowValue(row, col), literal) : (row) => !sameValue(col, rowValue(row, col), literal);
  });
  if (atoms.some((a) => !a)) return undefined;
  return (row) => atoms.every((a) => a!(row));
}

/**
 * A SET value: a literal, a column, or `CASE [col] WHEN … THEN … [ELSE …] END`.
 * Returns the new value for a row (undefined: unchanged), or undefined when
 * the expression isn't understood.
 */
function sqlValueExpr(expr: string): ((row: TodoRow) => string | undefined) | undefined {
  const literal = sqlLiteral(expr);
  if (typeof literal === 'string') return () => literal;
  if (literal === null) return () => undefined;
  const col = columnOf(expr);
  if (col) return (row) => rowValue(row, col);
  const caseExpr = /^CASE\b([\s\S]*)\bEND$/i.exec(expr.trim());
  if (!caseExpr) return undefined;
  // [subject] WHEN a THEN b … [ELSE c], keywords found at the top level.
  const parts = sqlSplit(` ${caseExpr[1]} `, /\s(?=(?:WHEN|THEN|ELSE)\s)/i);
  const subject = parts[0] && !/^(WHEN|THEN|ELSE)\s/i.test(parts[0]) ? columnOf(parts.shift()!) ?? null : undefined;
  if (subject === null) return undefined;
  const branches: Array<{ when: (row: TodoRow) => boolean; then: (row: TodoRow) => string | undefined }> = [];
  let otherwise: ((row: TodoRow) => string | undefined) | undefined;
  for (let i = 0; i < parts.length; i++) {
    const kw = /^(WHEN|THEN|ELSE)\s+([\s\S]*)$/i.exec(parts[i]);
    if (!kw) return undefined;
    const word = kw[1].toUpperCase();
    if (word === 'ELSE') {
      otherwise = sqlValueExpr(kw[2]);
      if (!otherwise) return undefined;
      continue;
    }
    const thenKw = word === 'WHEN' ? /^THEN\s+([\s\S]*)$/i.exec(parts[i + 1] ?? '') : null;
    if (!thenKw) return undefined;
    i++;
    let when: ((row: TodoRow) => boolean) | undefined;
    if (subject) {
      const v = sqlLiteral(kw[2]);
      if (typeof v === 'string') when = (row) => sameValue(subject, rowValue(row, subject), v);
    } else {
      when = sqlPredicate(kw[2]);
    }
    const then = sqlValueExpr(thenKw[1]);
    if (!when || !then) return undefined;
    branches.push({ when, then });
  }
  return (row) => {
    const branch = branches.find((b) => b.when(row));
    return branch ? branch.then(row) : otherwise?.(row);
  };
}

/** The `( … )` row tuples after VALUES, stopping at anything else (e.g. ON CONFLICT). */
function sqlTuples(values: string): string[][] {
  const tuples: string[][] = [];
  for (const part of sqlSplit(values, /,/)) {
    const tuple = sqlParenList(part);
    if (!tuple) break;
    tuples.push(tuple);
  }
  return tuples;
}

/** Applies one statement to the todo list; statements it doesn't understand are no change. */
function applyTodoStatement(statement: string, tasks: Map<string, AcpTask>): void {
  const insert = /^(?:INSERT|REPLACE)\b(\s+OR\s+\w+)?\s+INTO\s+["`]?todos["`]?\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(statement);
  if (insert) {
    const ignore = /\bIGNORE\b/i.test(insert[1] ?? '');
    const cols = insert[2].split(',').map((c) => c.trim().replace(/["`]/g, '').toLowerCase());
    for (const tuple of sqlTuples(insert[3])) {
      const row = Object.fromEntries(cols.map((c, i) => [c, tuple[i] === undefined ? undefined : sqlLiteral(tuple[i])]));
      const id = row.id ?? row.title;
      if (!id || (ignore && tasks.has(id))) continue;
      tasks.set(id, { id, content: row.title ?? row.description ?? id, status: taskStatus(row.status ?? undefined) });
    }
    return;
  }
  const update = /^UPDATE\s+(?:OR\s+\w+\s+)?["`]?todos["`]?\s+SET\s+([\s\S]*)$/i.exec(statement);
  if (update) {
    const [set, where, extra] = sqlSplit(update[1], /\s+WHERE\s+/i);
    if (extra !== undefined || set === undefined) return;
    const matches = where === undefined ? () => true : sqlPredicate(where);
    if (!matches) return;
    const assignments: Array<{ col: 'title' | 'status'; value: (row: TodoRow) => string | undefined }> = [];
    for (const assignment of sqlSplit(set, /,/)) {
      const m = /^(\S+?)\s*=\s*([\s\S]+)$/.exec(assignment);
      const col = m && columnOf(m[1]);
      if (!m || (col !== 'title' && col !== 'status')) continue; // description, updated_at, …
      const value = sqlValueExpr(m[2]);
      if (value) assignments.push({ col, value });
    }
    for (const task of tasks.values()) {
      if (!matches(task)) continue;
      // Every value is read from the row as it was before this statement.
      const before = { ...task };
      for (const { col, value } of assignments) {
        const v = value(before);
        if (v === undefined) continue;
        if (col === 'status') task.status = taskStatus(v);
        else task.content = v;
      }
    }
    return;
  }
  const del = /^DELETE\s+FROM\s+["`]?todos["`]?(?:\s+WHERE\s+([\s\S]*))?$/i.exec(statement);
  if (del) {
    const matches = del[1] === undefined ? () => true : sqlPredicate(del[1]);
    if (!matches) return;
    for (const [id, task] of [...tasks]) if (matches(task)) tasks.delete(id);
  }
}

/**
 * Copilot stores plan todos with its `sql` tool, e.g.
 * `INSERT OR REPLACE INTO todos (id, title, description, status) VALUES (…), …`,
 * `UPDATE todos SET status = CASE id WHEN 'a' THEN 'done' … END WHERE id IN (…)`
 * and `DELETE FROM todos WHERE status = 'done'`. Applies the statements that
 * touch `todos` to the current list. `undefined` when the list didn't change.
 */
export function copilotTasksAfterToolCall(rawInput: unknown, current: readonly AcpTask[]): AcpTask[] | undefined {
  const query = rawInput && typeof rawInput === 'object' ? (rawInput as { query?: unknown }).query : undefined;
  if (typeof query !== 'string' || !/\btodos\b/i.test(query)) return undefined;
  const tasks = new Map(current.map((t) => [t.id, { ...t }]));
  for (const statement of sqlSplit(query, /;/)) applyTodoStatement(statement, tasks);
  const next = [...tasks.values()];
  const same = next.length === current.length
    && next.every((t, i) => t.id === current[i].id && t.content === current[i].content && t.status === current[i].status);
  return same ? undefined : next;
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
