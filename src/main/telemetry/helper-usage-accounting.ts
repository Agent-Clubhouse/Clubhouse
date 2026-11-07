/**
 * What one helper run used, from the chat events its driver published (#2747).
 * Pure: no telemetry, no timers, no I/O, so provider semantics are testable
 * with plain events.
 *
 * Rules:
 * - A figure the provider did not report is absent. Zero is only a reported zero.
 * - A turn is counted once, by its turn id. A repeat of the same turn id is ignored.
 *   With no turn id, a turn is one `turnStarted` and its `turnEnded`: two turns that
 *   report equal figures are two turns (equal usage does not prove a repeat), and an
 *   end with no open turn is ignored as a repeat of one already closed. Such samples
 *   say `dedup: none`.
 * - A running total (a session or thread figure) is never added to a turn
 *   figure, and never to another thread's. Turn samples and the closing sample
 *   are separate readings of one run: use one, not both.
 * - A closing sample says whether it is this run's own use (`run`), carries a
 *   resumed native session's earlier use (`lifetime`), or covers only what came
 *   after a reset (`after_reset`). Only turn samples are a run's measured use.
 * - A running total that goes down was reset or compacted. The sample says so
 *   and claims no delta.
 * - Main-agent and inclusive (subagents counted) figures keep their scope. A
 *   driver that does not say gets `unscoped`, and nothing is added to it.
 * - A subagent's own thread is reported apart from the helper's main thread. A
 *   synthesized inclusive total is made only from threads proven disjoint (each
 *   named, each reported with `main` coverage, every declared subagent among
 *   them) that all report the same figures; otherwise it is left out.
 * - `source` says who did the arithmetic: the provider's turn figure, our sum of
 *   its per-call figures, or our difference of its running totals.
 * - Nothing here reads message text, tool input or output.
 */
import type { ChatDriverId } from '../../shared/chat/capabilities';
import type { ChatEventDataMap, TokenUsage } from '../../shared/chat/events';
import {
  HELPER_TELEMETRY_LIMITS,
  USAGE_FIGURE_KEYS,
  usageCompleteness,
  type UsageBaseline,
  type UsageCompleteness,
  type UsageDedup,
  type UsageFigures,
  type UsageScope,
  type UsageSource,
} from '../../shared/telemetry/helper-usage-contract';

export interface UsageSample {
  kind: 'turn' | 'final';
  source: UsageSource;
  dedup: UsageDedup;
  scope: UsageScope;
  figures: UsageFigures;
  completeness: UsageCompleteness;
  measuredAtMs: number;
  turnIndex?: number;
  durationMs?: number;
  /** Closing samples only: what the running total covers. */
  baseline?: UsageBaseline;
  /** A running total went down since the last one: reset or compaction. */
  reset?: boolean;
  /** Subagent threads exist whose figures this sample does not include. */
  subagentExcluded?: boolean;
}

export interface RunUsageCounts {
  turns: number;
  /** Finished turns that reported no usage at all. */
  turnsMissing: number;
  authErrors: number;
  rateLimitErrors: number;
  quotaErrors: number;
  samplesDropped: number;
}

type UsageData = ChatEventDataMap['usage'];
type TurnEndedData = ChatEventDataMap['turn_ended'];

interface OpenTurn {
  startMs: number;
  tokens?: TokenUsage;
  coverage?: 'main' | 'inclusive';
}

/** A thread's or session's running total, with its scope. */
interface Cumulative {
  tokens: TokenUsage;
  coverage: 'main' | 'inclusive' | undefined;
}

function figuresOf(t: TokenUsage | undefined): UsageFigures {
  const out: UsageFigures = {};
  if (!t) return out;
  if (t.input !== undefined) out.input = t.input;
  if (t.cachedInput !== undefined) out.cachedInput = t.cachedInput;
  if (t.cacheWrite !== undefined) out.cacheWrite = t.cacheWrite;
  if (t.output !== undefined) out.output = t.output;
  if (t.reasoning !== undefined) out.reasoning = t.reasoning;
  return out;
}

const valid = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Only valid, non-negative figures; anything else is treated as not reported. */
function clean(f: UsageFigures): UsageFigures {
  const out: UsageFigures = {};
  for (const key of USAGE_FIGURE_KEYS) if (valid(f[key])) out[key] = Math.trunc(f[key]!);
  return out;
}

/** Who computed a turn figure for this driver. */
function turnSourceFor(driver: ChatDriverId): UsageSource {
  // The Copilot SDK reports each model call; the turn is our sum. Codex reports running totals; the turn is our difference.
  return driver === 'copilot_sdk' ? 'summed_calls' : driver === 'codex_app_server' ? 'cumulative_delta' : 'provider_turn';
}

function finalSourceFor(driver: ChatDriverId): UsageSource {
  return driver === 'copilot_sdk' ? 'summed_calls' : 'provider_session_cumulative';
}

export class RunUsageTracker {
  readonly counts: RunUsageCounts = { turns: 0, turnsMissing: 0, authErrors: 0, rateLimitErrors: 0, quotaErrors: 0, samplesDropped: 0 };
  private readonly open = new Map<string, OpenTurn>();
  private readonly counted = new Set<string>();
  /** The cumulative figures per thread; '' is the run's session-level figure when the driver names no thread. */
  private readonly cumulative = new Map<string, Cumulative>();
  private readonly subagentThreads = new Set<string>();
  /** Subagents the driver announced, whether or not they ever reported usage. */
  private readonly declaredSubagents = new Set<string>();
  private reset = false;
  private emitted = 0;
  private quotaWindowsExceeded = new Set<string>();

  /** `resumed`: the run continues a native session, so the provider's running totals carry earlier runs' use. */
  constructor(
    private readonly driver: ChatDriverId,
    private readonly maxSamples: number = HELPER_TELEMETRY_LIMITS.maxUsageSamplesPerRun,
    private readonly resumed = false,
  ) {}

  turnStarted(turnId: string | undefined, atMs: number): void {
    this.open.set(turnId ?? '', { startMs: atMs });
  }

  /** The driver announced a subagent (a Codex thread, say). */
  subagentDeclared(id: string): void {
    this.declaredSubagents.add(id);
  }

  /** A `usage` event. Turn figures are held for the turn's end; running totals are kept as the latest of their thread. */
  usage(data: UsageData, turnId: string | undefined): void {
    if (data.limits) {
      for (const limit of data.limits) {
        if (limit.status === 'exceeded' && !this.quotaWindowsExceeded.has(limit.window)) {
          this.quotaWindowsExceeded.add(limit.window);
          this.counts.quotaErrors++;
        }
      }
    }
    if (!data.tokens) return;
    if (data.scope === 'turn') {
      const turn = this.open.get(turnId ?? '');
      if (!turn) return;
      // The same turn reporting again replaces its figures: it is the same turn's total, not another turn.
      turn.tokens = data.tokens;
      turn.coverage = data.coverage;
      return;
    }
    const key = data.threadId ?? '';
    const before = this.cumulative.get(key);
    if (data.subagentId !== undefined) this.subagentThreads.add(key);
    if (before && this.wentDown(before.tokens, data.tokens)) this.reset = true;
    this.cumulative.set(key, { tokens: data.tokens, coverage: data.coverage });
  }

  private wentDown(before: TokenUsage, after: TokenUsage): boolean {
    for (const key of ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning'] as const) {
      const a = before[key];
      const b = after[key];
      if (valid(a) && valid(b) && b < a) return true;
    }
    return false;
  }

  /** A chat `error`: counted by class when it is one the join cares about. */
  error(code: string): void {
    if (code === 'auth_required') this.counts.authErrors++;
    else if (code === 'rate_limited') this.counts.rateLimitErrors++;
  }

  /** A turn finished. Returns its sample, or undefined for a repeat of a turn already counted or past the cap. */
  turnEnded(turnId: string | undefined, data: TurnEndedData, atMs: number): UsageSample | undefined {
    const key = turnId ?? '';
    const turn = this.open.get(key);
    this.open.delete(key);
    if (turnId !== undefined) {
      if (this.counted.has(turnId)) return undefined;
      this.counted.add(turnId);
    } else if (!turn) {
      // No id and no open turn: this end belongs to a turn already closed.
      return undefined;
    }
    const figures = clean(figuresOf(data.usage ?? turn?.tokens));
    this.counts.turns++;
    if (Object.keys(figures).length === 0) this.counts.turnsMissing++;
    return this.admit({
      kind: 'turn',
      source: turnSourceFor(this.driver),
      dedup: turnId !== undefined ? 'turn_id' : 'none',
      scope: turn?.coverage ?? 'unscoped',
      figures,
      completeness: usageCompleteness(figures),
      measuredAtMs: atMs,
      turnIndex: this.counts.turns,
      durationMs: data.durationMs ?? (turn ? atMs - turn.startMs : undefined),
    });
  }

  private admit(sample: UsageSample): UsageSample | undefined {
    // Keep room for the closing samples: a few turn samples never crowd them out.
    const room = sample.kind === 'final' ? this.maxSamples + 2 : this.maxSamples;
    if (this.emitted >= room) {
      this.counts.samplesDropped++;
      return undefined;
    }
    this.emitted++;
    return sample;
  }

  private baseline(): UsageBaseline {
    return this.reset ? 'after_reset' : this.resumed ? 'lifetime' : 'run';
  }

  /**
   * The closing samples, from the provider's running totals. The helper's own
   * (main) figure, and, only when it can be proven, an inclusive figure that is
   * the sum of every thread's total. None when the provider reported no totals.
   */
  finalSamples(atMs: number): UsageSample[] {
    const out: UsageSample[] = [];
    const subagents = [...this.cumulative.entries()].filter(([key]) => this.subagentThreads.has(key));
    const mains = [...this.cumulative.entries()].filter(([key]) => !this.subagentThreads.has(key));
    const hasThreads = [...this.cumulative.keys()].some((key) => key !== '');
    for (const [, c] of mains) {
      const figures = clean(figuresOf(c.tokens));
      const sample = this.admit({
        kind: 'final',
        source: finalSourceFor(this.driver),
        dedup: hasThreads ? 'thread_cumulative' : 'none',
        scope: c.coverage ?? 'unscoped',
        figures,
        completeness: usageCompleteness(figures),
        measuredAtMs: atMs,
        baseline: this.baseline(),
        ...(this.reset && { reset: true }),
        ...(subagents.length > 0 && { subagentExcluded: true }),
      });
      if (sample) out.push(sample);
    }
    const inclusive = this.inclusiveFigures(mains, subagents);
    if (inclusive) {
      const sample = this.admit({
        kind: 'final',
        source: finalSourceFor(this.driver),
        dedup: 'thread_cumulative',
        scope: 'inclusive',
        figures: inclusive,
        completeness: usageCompleteness(inclusive),
        measuredAtMs: atMs,
        baseline: this.baseline(),
      });
      if (sample) out.push(sample);
    }
    return out;
  }

  /**
   * The sum of the helper's thread and its subagent threads, or undefined. It is
   * made only when: no reset happened; the threads are named and distinct; every one
   * reported `main` (thread-only) coverage, so none already includes another; every
   * declared subagent reported; and every thread reported the same set of figures,
   * so no sum hides a contributor that left one out.
   */
  private inclusiveFigures(mains: Array<[string, Cumulative]>, subagents: Array<[string, Cumulative]>): UsageFigures | undefined {
    if (subagents.length === 0 || mains.length !== 1 || this.reset) return undefined;
    const threads = [...mains, ...subagents];
    if (threads.some(([key, c]) => key === '' || c.coverage !== 'main')) return undefined;
    for (const id of this.declaredSubagents) if (!this.cumulative.has(id)) return undefined;
    const parts = threads.map(([, c]) => clean(figuresOf(c.tokens)));
    const reported = USAGE_FIGURE_KEYS.filter((k) => parts.some((p) => p[k] !== undefined));
    if (reported.some((k) => parts.some((p) => p[k] === undefined))) return undefined;
    const sum: UsageFigures = {};
    for (const k of reported) sum[k] = parts.reduce((total, p) => total + p[k]!, 0);
    return sum;
  }
}
