/**
 * Turns a headless run's stream-json transcript into the run monitor's
 * timeline (#2019): text and tool steps with their time, target and outcome,
 * consecutive reads and searches folded into one row, plus the numbers the
 * progress column shows.
 *
 * Events carry `_ts` (stamped by the main process, #2033). Older transcripts
 * without it fall back to the time the step was first seen.
 */

export interface TranscriptEventLike {
  type?: string;
  _ts?: number;
  message?: { content?: unknown; usage?: Record<string, unknown> };
  content_block?: { type?: string; name?: string; id?: string; input?: Record<string, unknown> };
  delta?: { type?: string; text?: string };
  index?: number;
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

export interface TextStep {
  kind: 'text';
  id: string;
  ts: number;
  text: string;
}

export interface ToolStep {
  kind: 'tool';
  id: string;
  ts: number;
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  /** When its result arrived; undefined while it runs. */
  endTs?: number;
  isError?: boolean;
}

export interface ResultStep {
  kind: 'result';
  id: string;
  ts: number;
  text: string;
  isError: boolean;
}

export type Step = TextStep | ToolStep | ResultStep;

/** Consecutive reads and searches, shown as one expandable row. */
export interface FoldStep {
  kind: 'fold';
  id: string;
  ts: number;
  steps: ToolStep[];
}

export type TimelineRow = TextStep | ToolStep | ResultStep | FoldStep;

export interface RunTotals {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  durationMs?: number;
  summary: string | null;
  resultIsError: boolean;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

/**
 * Incremental builder: feed it transcript pages in order. Keeps tool steps by
 * `tool_use_id` so a later result completes the right step.
 */
export class TimelineBuilder {
  readonly steps: Step[] = [];
  readonly totals: RunTotals = { toolCalls: 0, inputTokens: 0, outputTokens: 0, summary: null, resultIsError: false };
  private byToolUseId = new Map<string, ToolStep>();
  private legacyBlocks = new Map<number, ToolStep>();
  private pendingText = '';
  private pendingTs = 0;
  private seq = 0;
  private lastAssistantText = '';
  /** Claude repeats a message's usage on every event of it: keep the latest per message id. */
  private usageByMessage = new Map<string, [number, number]>();
  private anonymousUsage: [number, number] = [0, 0];
  /** Codex reports per-turn usage on its result events. */
  private resultUsage: [number, number] = [0, 0];
  /** A result event's own total, used only when nothing else reported usage. */
  private resultTotal: [number, number] | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  push(events: TranscriptEventLike[]): void {
    for (const e of events) this.pushOne(e);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}:${this.seq}`;
  }

  private flushText(): void {
    const text = this.pendingText.trim();
    this.pendingText = '';
    if (!text) return;
    this.steps.push({ kind: 'text', id: this.nextId('text'), ts: this.pendingTs, text });
    this.lastAssistantText = text;
  }

  private addTool(ts: number, name: string, input: Record<string, unknown> | undefined, toolUseId?: string): ToolStep | null {
    if (toolUseId && this.byToolUseId.has(toolUseId)) return null; // Codex repeats tool_use on completion
    this.flushText();
    const step: ToolStep = { kind: 'tool', id: toolUseId ? `tool:${toolUseId}` : this.nextId('tool'), ts, name, input: input ?? {}, toolUseId };
    this.steps.push(step);
    this.totals.toolCalls += 1;
    if (toolUseId) this.byToolUseId.set(toolUseId, step);
    return step;
  }

  private pushOne(e: TranscriptEventLike): void {
    const ts = typeof e._ts === 'number' ? e._ts : this.now();
    const content = Array.isArray(e.message?.content) ? (e.message!.content as ContentBlock[]) : null;

    if (e.type === 'assistant' && content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          if (!this.pendingText) this.pendingTs = ts;
          this.pendingText += block.text;
        } else if (block.type === 'tool_use' && block.name) {
          this.addTool(ts, block.name, block.input, block.id);
        }
      }
      this.flushText();
      const usage = readUsage(e.message?.usage);
      if (usage) {
        const id = (e.message as { id?: unknown }).id;
        if (typeof id === 'string' && id) this.usageByMessage.set(id, usage);
        else this.anonymousUsage = add(this.anonymousUsage, usage);
        this.updateTokens();
      }
      return;
    }

    if (e.type === 'user' && content) {
      for (const block of content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const step = this.byToolUseId.get(block.tool_use_id);
        if (step && step.endTs === undefined) {
          step.endTs = ts;
          step.isError = !!block.is_error;
        }
      }
      return;
    }

    // Legacy streaming format
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      const step = this.addTool(ts, e.content_block.name || 'unknown', e.content_block.input, e.content_block.id);
      if (step && typeof e.index === 'number') this.legacyBlocks.set(e.index, step);
      return;
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      if (!this.pendingText) this.pendingTs = ts;
      this.pendingText += e.delta.text;
      return;
    }
    if (e.type === 'content_block_stop') {
      const step = typeof e.index === 'number' ? this.legacyBlocks.get(e.index) : undefined;
      if (step) {
        step.endTs ??= ts;
        this.legacyBlocks.delete(e.index!);
      }
      this.flushText();
      return;
    }
    if (e.type === 'message_start' || e.type === 'message_stop') {
      this.flushText();
      return;
    }

    if (e.type === 'result') {
      this.flushText();
      const text = typeof e.result === 'string' ? e.result.trim() : '';
      this.totals.summary = text || this.lastAssistantText || null;
      this.totals.resultIsError = !!e.is_error;
      const cost = e.total_cost_usd ?? e.cost_usd;
      if (typeof cost === 'number' && cost > 0) this.totals.costUsd = cost;
      if (typeof e.duration_ms === 'number') this.totals.durationMs = e.duration_ms;
      const turn = readUsage(e.message?.usage);
      if (turn) this.resultUsage = add(this.resultUsage, turn);
      const total = readUsage(e.usage as Record<string, unknown> | undefined);
      if (total) this.resultTotal = total;
      this.updateTokens();
      this.steps.push({ kind: 'result', id: this.nextId('result'), ts, text, isError: !!e.is_error });
    }
  }

  private updateTokens(): void {
    let sum = add(this.anonymousUsage, this.resultUsage);
    for (const u of this.usageByMessage.values()) sum = add(sum, u);
    if (sum[0] === 0 && sum[1] === 0 && this.resultTotal) sum = this.resultTotal;
    this.totals.inputTokens = sum[0];
    this.totals.outputTokens = sum[1];
  }
}

function readUsage(usage: Record<string, unknown> | undefined): [number, number] | null {
  if (!usage || typeof usage !== 'object') return null;
  const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
  return [n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens'), n('output_tokens')];
}

function add(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

/* ── Describing a tool step ───────────────────────────────────────── */

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'LS', 'read_file', 'view']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'search', 'grep', 'glob', 'find']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'str_replace', 'edit_file']);
const WRITE_TOOLS = new Set(['Write', 'create_file', 'write_file']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'bash', 'run_shell_command', 'BashOutput']);

export type ToolGlyph = 'file' | 'search' | 'pencil' | 'term' | 'globe' | 'tool';

export interface ToolDescription {
  /** Past tense ("Edited"); `active` is present tense for a step still running ("Editing"). */
  verb: string;
  active: string;
  target: string;
  /** Where the target lives (a directory), or extra context. */
  detail: string;
  /** Show the target in mono (commands, patterns). */
  mono: boolean;
  glyph: ToolGlyph;
  /** File the step changed, for the diff size. */
  changedPath?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function splitDir(p: string): { name: string; dir: string } {
  const clean = p.replace(/\\/g, '/');
  const i = clean.lastIndexOf('/');
  return i < 0 ? { name: clean, dir: '' } : { name: clean.slice(i + 1), dir: clean.slice(0, i) };
}

function firstLine(s: string, max = 120): string {
  const line = s.split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** First file named in an apply_patch input (a path, or a patch body). */
function patchPath(input: Record<string, unknown>): string {
  const direct = str(input.path) || str(input.file_path);
  if (direct) return direct;
  const body = str(input.patch) || str(input.input) || str(input.command);
  const m = body.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
  return m ? m[1].trim() : '';
}

export function isReadOrSearch(name: string): boolean {
  return READ_TOOLS.has(name) || SEARCH_TOOLS.has(name);
}

/** Relative to the run's directory when inside it. */
function rel(p: string, base?: string): string {
  if (!base || !p) return p;
  const a = p.replace(/\\/g, '/');
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return a.startsWith(b + '/') ? a.slice(b.length + 1) : a;
}

export function describeTool(step: ToolStep, base?: string): ToolDescription {
  const { name, input } = step;
  if (READ_TOOLS.has(name)) {
    const p = rel(str(input.file_path) || str(input.notebook_path) || str(input.path), base);
    const { name: n, dir } = splitDir(p);
    return { verb: 'Read', active: 'Reading', target: n || 'a file', detail: dir, mono: false, glyph: 'file' };
  }
  if (SEARCH_TOOLS.has(name)) {
    const pattern = str(input.pattern) || str(input.query) || str(input.glob);
    return { verb: 'Searched', active: 'Searching', target: firstLine(pattern) || 'files', detail: rel(str(input.path), base), mono: true, glyph: 'search' };
  }
  if (EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const p = rel(name === 'apply_patch' ? patchPath(input) : str(input.file_path) || str(input.notebook_path) || str(input.path), base);
    const { name: n, dir } = splitDir(p);
    const write = WRITE_TOOLS.has(name);
    return { verb: write ? 'Wrote' : 'Edited', active: write ? 'Writing' : 'Editing', target: n || 'files', detail: dir, mono: false, glyph: 'pencil', changedPath: p || undefined };
  }
  if (SHELL_TOOLS.has(name)) {
    const cmd = str(input.command) || str(input.cmd);
    return { verb: 'Ran', active: 'Running', target: firstLine(cmd) || 'a command', detail: '', mono: true, glyph: 'term' };
  }
  if (name === 'WebFetch') {
    return { verb: 'Fetched', active: 'Fetching', target: str(input.url), detail: '', mono: true, glyph: 'globe' };
  }
  if (name === 'WebSearch') {
    return { verb: 'Searched the web for', active: 'Searching the web for', target: str(input.query), detail: '', mono: false, glyph: 'globe' };
  }
  if (name === 'Task' || name === 'Agent') {
    return { verb: 'Delegated', active: 'Delegating', target: str(input.description) || 'a task', detail: '', mono: false, glyph: 'tool' };
  }
  if (name === 'TodoWrite') {
    return { verb: 'Updated the plan', active: 'Updating the plan', target: '', detail: '', mono: false, glyph: 'tool' };
  }
  const firstString = Object.values(input).find((v): v is string => typeof v === 'string') ?? '';
  return { verb: name, active: name, target: firstLine(firstString, 80), detail: '', mono: true, glyph: 'tool' };
}

/** "Read 6 files", "Searched 2 patterns", "Read 4 files, searched 2". */
export function describeFold(steps: ToolStep[]): string {
  const reads = steps.filter((s) => READ_TOOLS.has(s.name)).length;
  const searches = steps.length - reads;
  const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
  if (!searches) return `Read ${files(reads)}`;
  if (!reads) return `Searched ${searches} ${searches === 1 ? 'pattern' : 'patterns'}`;
  return `Read ${files(reads)}, searched ${searches}`;
}

/** Fold runs of two or more consecutive reads and searches into one row. */
export function foldSteps(steps: Step[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: 'fold', id: `fold:${run[0].id}`, ts: run[0].ts, steps: run });
    else rows.push(...run);
    run = [];
  };
  for (const s of steps) {
    if (s.kind === 'tool' && isReadOrSearch(s.name)) {
      run.push(s);
      continue;
    }
    flush();
    rows.push(s);
  }
  flush();
  return rows;
}

/** Paths a run changed, in first-seen order, from its edit and write steps. */
export function changedPaths(steps: Step[], base?: string): string[] {
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.kind !== 'tool') continue;
    const p = describeTool(s, base).changedPath;
    if (p && !seen.has(p)) seen.add(p);
  }
  return [...seen];
}

/** Tool calls per bucket since `start`, for the progress sparkline. */
export function toolCallBuckets(steps: Step[], start: number, end: number, bucketMs = 20_000): number[] {
  const count = Math.max(1, Math.ceil((end - start) / bucketMs));
  const buckets = new Array<number>(count).fill(0);
  for (const s of steps) {
    if (s.kind !== 'tool') continue;
    const i = Math.floor((s.ts - start) / bucketMs);
    if (i >= 0 && i < count) buckets[i] += 1;
  }
  return buckets;
}

/** "0:11", "12:03" from the run's start. */
export function clock(ts: number, start: number): string {
  const s = Math.max(0, Math.floor((ts - start) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
