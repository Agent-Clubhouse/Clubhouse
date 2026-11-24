import { describe, expect, it } from 'vitest';
import { createCodexHeadlessNormalizer } from '../orchestrators/codex-headless-events';
import type { StreamJsonEvent } from './jsonl-parser';
import { HeadlessUsageAccumulator, readStreamUsage } from './headless-usage';

function feed(events: unknown[]): HeadlessUsageAccumulator {
  const acc = new HeadlessUsageAccumulator();
  for (const e of events) acc.note(e);
  return acc;
}

describe('headless run usage', () => {
  it('Claude: cache reads and writes join input, a message repeated per block counts once', () => {
    const usage = { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 };
    const acc = feed([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'secret' }], usage } },
      { type: 'assistant', message: { id: 'm1', content: [], usage } },
      { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'result', usage: { input_tokens: 99_999, output_tokens: 99_999 } },
    ]);
    expect(acc.result()).toEqual({ tokens: { input: 1001, cachedInput: 900, cacheWrite: 90, output: 6 }, source: 'summed_calls', dedup: 'message_id' });
  });

  it('Claude: the result total is used only when no message reported usage', () => {
    expect(feed([{ type: 'result', usage: { input_tokens: 40, output_tokens: 4 } }]).result()).toEqual({ tokens: { input: 40, output: 4 }, source: 'provider_turn', dedup: 'none' });
  });

  it('Codex exec: each turn added, cached input and reasoning kept as parts, through the real normalizer', () => {
    const normalize = createCodexHeadlessNormalizer();
    const raw = [
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20, reasoning_output_tokens: 8 } },
      { type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 10 } },
    ] as unknown as StreamJsonEvent[];
    const acc = feed(raw.flatMap(normalize));
    expect(acc.result()).toEqual({ tokens: { input: 1500, cachedInput: 800, output: 30, reasoning: 8 }, source: 'summed_calls', dedup: 'none' });
  });

  it('nothing reported is no usage, not zeros; a reported zero stays zero', () => {
    const normalize = createCodexHeadlessNormalizer();
    expect(feed(([{ type: 'turn.completed', usage: {} }] as unknown as StreamJsonEvent[]).flatMap(normalize)).result()).toBeUndefined();
    expect(feed([{ type: 'result', message: { usage: { input_tokens: 0, output_tokens: 0 } } }]).result()?.tokens).toEqual({ input: 0, output: 0 });
    expect(readStreamUsage({ output_tokens: 3 })).toEqual({ output: 3 });
    // Cache parts without input_tokens: the total input isn't known, only its parts.
    expect(readStreamUsage({ cache_read_input_tokens: 7, output_tokens: 1 })).toEqual({ cachedInput: 7, output: 1 });
    expect(readStreamUsage({ input_tokens: -1, output_tokens: 'x' })).toBeUndefined();
  });
});
