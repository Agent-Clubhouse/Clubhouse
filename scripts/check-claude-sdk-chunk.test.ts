/**
 * CI guard for bundling the Claude Agent SDK (docs/structured-chat-research.md
 * §8 "Spikes: Packaging"): builds the main bundle and fails if the SDK leaks
 * into the entry chunk, its chunk exceeds 2 MB, any of its CLI binaries is
 * emitted, or the bundled chunk can't drive a fake `claude`.
 *
 * The webpack build takes ~30-60 s, so it runs on the Linux CI runner only
 * (chunking is platform-independent). Run it anywhere with
 * CLUBHOUSE_CHECK_CLAUDE_SDK_CHUNK=1, or `node scripts/check-claude-sdk-chunk.mjs`.
 */
import { describe, expect, it } from 'vitest';

const enabled = process.platform === 'linux' || process.env.CLUBHOUSE_CHECK_CLAUDE_SDK_CHUNK === '1';

describe.skipIf(!enabled)('Claude Agent SDK chunk', () => {
  it('bundles the SDK as a lazy chunk without its binaries, and the chunk runs', async () => {
    const { checkClaudeSdkChunk, LIMIT_BYTES } = await import('./check-claude-sdk-chunk.mjs');
    const { report, failures } = await checkClaudeSdkChunk();
    expect(failures).toEqual([]);
    expect(report.sdkBytes).toBeLessThanOrEqual(LIMIT_BYTES);
  }, 300_000);
});
