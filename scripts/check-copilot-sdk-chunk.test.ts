/**
 * CI guard for bundling the Copilot SDK (docs/copilot-sdk-driver.md): builds
 * the main bundle and fails if the SDK leaks into the entry chunk, its chunks
 * exceed 1 MB, any runtime package or native binary (koffi) is emitted, or
 * the bundled chunk can't handshake with a fake `copilot`.
 *
 * Like the Claude SDK check, the webpack build takes a few minutes, so it runs
 * on the Linux CI runner only (chunking is platform-independent). Run it
 * anywhere with CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK=1, or
 * `node scripts/check-copilot-sdk-chunk.mjs`.
 */
import { describe, expect, it } from 'vitest';

const enabled = process.platform === 'linux' || process.env.CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK === '1';

describe.skipIf(!enabled)('Copilot SDK chunk', () => {
  it('bundles the SDK as a lazy chunk without runtime packages or native binaries, and the chunk handshakes', async () => {
    const { checkCopilotSdkChunk, LIMIT_BYTES } = await import('./check-copilot-sdk-chunk.mjs');
    const { report, failures } = await checkCopilotSdkChunk();
    expect(failures).toEqual([]);
    expect(report.sdkBytes).toBeLessThanOrEqual(LIMIT_BYTES);
    expect(report.smoke.status.argv).toEqual(['--headless', '--no-auto-update', '--stdio']);
  }, 600_000);
});
