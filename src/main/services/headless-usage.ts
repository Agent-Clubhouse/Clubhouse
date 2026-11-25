/**
 * What one headless run used, from its normalized stream-json events
 * (docs/usage-attribution.md). Keeps only the numbers as events arrive, so
 * the in-memory transcript cap evicting events loses nothing, and no content
 * is held.
 *
 * Same counting as the run summary (shared/headless-transcript.ts):
 * - Claude repeats a message's usage on each of its events: counted once per
 *   message id, the last report winning. Without an id, each report is added.
 * - Codex reports each turn on its `result` event (`message.usage`): added.
 * - A `result` event's top-level `usage` is the run's own total (Claude),
 *   used only when no per-message figure was seen.
 *
 * Figures follow the chat TokenUsage convention: `input` includes cache reads
 * and writes. A figure no event reported is absent; a reported 0 stays 0.
 */
import type { TokenUsage } from '../../shared/chat';
import type { UsageSource } from '../../shared/telemetry/helper-usage-contract';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** One usage report in the contract's convention, from Claude or Codex stream-json usage. */
export function readStreamUsage(usage: unknown): TokenUsage | undefined {
  if (!isRec(usage)) return undefined;
  const base = count(usage.input_tokens);
  // Claude reports input without cache reads and writes; Codex's input_tokens already includes cached input.
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const out: TokenUsage = {};
  // Total input only when input_tokens itself was reported: cache parts alone would make a lower bound look like a total.
  if (base !== undefined) out.input = base + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const cached = cacheRead ?? count(usage.cached_input_tokens);
  if (cached !== undefined) out.cachedInput = cached;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  const output = count(usage.output_tokens);
  if (output !== undefined) out.output = output;
  const reasoning = count(usage.reasoning_output_tokens);
  if (reasoning !== undefined) out.reasoning = reasoning;
  return Object.keys(out).length > 0 ? out : undefined;
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {};
  for (const k of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

export interface HeadlessRunUsage {
  tokens: TokenUsage;
  /** Our sum of per-message or per-turn figures, or the provider's own run total. */
  source: UsageSource;
  /** How repeats were told apart: by message id, or not at all (summed as reported). */
  dedup: 'message_id' | 'none';
}

export class HeadlessUsageAccumulator {
  private readonly byMessage = new Map<string, TokenUsage>();
  private anonymous: TokenUsage = {};
  private resultTurns: TokenUsage = {};
  private resultTotal: TokenUsage | undefined;
  private sawPerMessage = false;
  private sawAnonymous = false;

  note(event: unknown): void {
    if (!isRec(event)) return;
    const message = isRec(event.message) ? event.message : undefined;
    if (event.type === 'assistant' && message) {
      const usage = readStreamUsage(message.usage);
      if (!usage) return;
      this.sawPerMessage = true;
      if (typeof message.id === 'string' && message.id) this.byMessage.set(message.id, usage);
      else {
        this.anonymous = add(this.anonymous, usage);
        this.sawAnonymous = true;
      }
      return;
    }
    if (event.type !== 'result') return;
    const turn = message ? readStreamUsage(message.usage) : undefined;
    if (turn) {
      this.sawPerMessage = true;
      this.sawAnonymous = true;
      this.resultTurns = add(this.resultTurns, turn);
    }
    const total = readStreamUsage(event.usage);
    if (total) this.resultTotal = total;
  }

  /** The run's figures, or undefined when nothing reported any. */
  result(): HeadlessRunUsage | undefined {
    if (!this.sawPerMessage) {
      return this.resultTotal ? { tokens: this.resultTotal, source: 'provider_turn', dedup: 'none' } : undefined;
    }
    let tokens = add(this.anonymous, this.resultTurns);
    for (const u of this.byMessage.values()) tokens = add(tokens, u);
    return { tokens, source: 'summed_calls', dedup: this.sawAnonymous ? 'none' : 'message_id' };
  }
}
