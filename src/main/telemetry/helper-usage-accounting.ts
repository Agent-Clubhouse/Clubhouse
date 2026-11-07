/**
 * What one helper run used, from the chat events its driver published (#2747).
 * Pure: no telemetry, no timers, no I/O, so provider semantics are testable
 * with plain events.
 *
 * Rules:
 * - A figure the provider did not report is absent. Zero is only a reported zero.
 * - A turn is counted once, by its turn id. A repeat of the same turn is ignored.
 *   With no turn id the sample says so (`dedup: none`) instead of guessing.
 * - A running total (a session or thread figure) is never added to a turn
 *   figure, and never to another thread's. Turn samples and the closing sample
 *   are separate readings of one run: use one, not both.
 * - A running total that goes down was reset or compacted. The sample says so
 *   and claims no delta.
 * - Main-agent and inclusive (subagents counted) figures keep their scope. A
 *   driver that does not say gets `unscoped`, and nothing is added to it.
 * - A subagent's own thread is reported apart from the helper's main thread.
 * - Nothing here reads message text, tool input or output.
 */
import type { ChatDriverId } from '../../shared/chat/capabilities';
import type { ChatEventDataMap, TokenUsage } from '../../shared/chat/events';
import {
  HELPER_TELEMETRY_LIMITS,
  usageCompleteness,
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
  for (const key of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) if (valid(f[key])) out[key] = Math.trunc(f[key]!);
  return out;
}

/** How this driver tells a repeat from a new report, as far as the events show. */
function turnDedupFor(driver: ChatDriverId, hasTurnId: boolean): UsageDedup {
  if (hasTurnId) return 'turn_id';
  return driver === 'acp' || driver === 'copilot_acp' ? 'content_equal' : 'none';
}

export class RunUsageTracker {
  readonly counts: RunUsageCounts = { turns: 0, turnsMissing: 0, authErrors: 0, rateLimitErrors: 0, quotaErrors: 0, samplesDropped: 0 };
  private readonly open = new Map<string, OpenTurn>();
  private readonly counted = new Set<string>();
  /** The cumulative figures per thread; '' is the run's session-level figure when the driver names no thread. */
  private readonly cumulative = new Map<string, Cumulative>();
  private readonly subagentThreads = new Set<string>();
  private reset = false;
  private emitted = 0;
  private quotaWindowsExceeded = new Set<string>();
  private lastNoTurnKey: string | undefined;

  constructor(private readonly driver: ChatDriverId, private readonly maxSamples = HELPER_TELEMETRY_LIMITS.maxUsageSamplesPerRun) {}

  turnStarted(turnId: string | undefined, atMs: number): void {
    this.open.set(turnId ?? '', { startMs: atMs });
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
    const turn = this.open.get(turnId ?? '');
    this.open.delete(turnId ?? '');
    if (turnId !== undefined) {
      if (this.counted.has(turnId)) return undefined;
      this.counted.add(turnId);
    }
    const tokens = data.usage ?? turn?.tokens;
    const figures = clean(figuresOf(tokens));
    // Without a turn id, an identical report right after another is a repeat (a local command re-sent the last usage).
    if (turnId === undefined && Object.keys(figures).length > 0) {
      const key = JSON.stringify(figures);
      if (key === this.lastNoTurnKey) return undefined;
      this.lastNoTurnKey = key;
    }
    this.counts.turns++;
    if (Object.keys(figures).length === 0) this.counts.turnsMissing++;
    const sample: UsageSample = {
      kind: 'turn',
      source: 'provider_turn',
      dedup: turnDedupFor(this.driver, turnId !== undefined),
      scope: turn?.coverage ?? 'unscoped',
      figures,
      completeness: usageCompleteness(figures),
      measuredAtMs: atMs,
      turnIndex: this.counts.turns,
      durationMs: data.durationMs ?? (turn ? atMs - turn.startMs : undefined),
    };
    return this.admit(sample);
  }

  private admit<T extends UsageSample>(sample: T): T | undefined {
    // Keep room for the closing samples: a few turn samples never crowd them out.
    const room = sample.kind === 'final' ? this.maxSamples + 2 : this.maxSamples;
    if (this.emitted >= room) {
      this.counts.samplesDropped++;
      return undefined;
    }
    this.emitted++;
    return sample;
  }

  /**
   * The closing samples, from the provider's running totals. The helper's own
   * (main) figure, and when subagent threads were seen, an inclusive figure that
   * is the sum of every thread's total. None when the provider reported no totals.
   */
  finalSamples(atMs: number): UsageSample[] {
    const out: UsageSample[] = [];
    const subagents = [...this.cumulative.entries()].filter(([key]) => this.subagentThreads.has(key));
    const mains = [...this.cumulative.entries()].filter(([key]) => !this.subagentThreads.has(key));
    const hasThreads = [...this.cumulative.keys()].some((key) => key !== '');
    for (const [, c] of mains) {
      const figures = clean(figuresOf(c.tokens));
      const sample = this.admit<UsageSample>({
        kind: 'final',
        source: 'provider_session_cumulative',
        dedup: hasThreads ? 'thread_cumulative' : 'none',
        scope: c.coverage ?? 'unscoped',
        figures,
        completeness: usageCompleteness(figures),
        measuredAtMs: atMs,
        ...(this.reset && { reset: true }),
        ...(subagents.length > 0 && { subagentExcluded: true }),
      });
      if (sample) out.push(sample);
    }
    if (subagents.length > 0 && mains.length === 1 && !this.reset) {
      // Each thread's own running total, added once: inclusive of the helper and what it spawned.
      const sum: UsageFigures = {};
      for (const [, c] of [...mains, ...subagents]) {
        const f = clean(figuresOf(c.tokens));
        for (const key of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) {
          if (f[key] !== undefined) sum[key] = (sum[key] ?? 0) + f[key]!;
        }
      }
      const sample = this.admit<UsageSample>({
        kind: 'final',
        source: 'provider_session_cumulative',
        dedup: 'thread_cumulative',
        scope: 'inclusive',
        figures: sum,
        completeness: usageCompleteness(sum),
        measuredAtMs: atMs,
      });
      if (sample) out.push(sample);
    }
    return out;
  }
}
