/**
 * CI guard for the telemetry lazy chunks (docs/telemetry-otel-spec.md §6.3):
 * builds the main bundle and fails if the OpenTelemetry SDK leaks into the
 * entry chunk, if the Azure exporter's ConfigurationManager is duplicated,
 * or if SDK + destination exceeds 2 MB minified.
 *
 * The webpack build takes ~30-60 s, so it runs on the Linux CI runner only
 * (chunking is platform-independent). Run it anywhere with
 * CLUBHOUSE_CHECK_TELEMETRY_CHUNKS=1, or `node scripts/check-telemetry-chunk-size.mjs`.
 */
import { describe, expect, it } from 'vitest';

const enabled = process.platform === 'linux' || process.env.CLUBHOUSE_CHECK_TELEMETRY_CHUNKS === '1';

describe.skipIf(!enabled)('telemetry chunk size', () => {
  it('keeps the SDK out of the entry chunk and each destination under 2 MB', async () => {
    const { checkTelemetryChunks, LIMIT_BYTES } = await import('./check-telemetry-chunk-size.mjs');
    const { report, failures } = await checkTelemetryChunks();
    expect(failures).toEqual([]);
    for (const dest of Object.values(report.destinations) as Array<{ totalWithSdkBytes: number }>) {
      expect(dest.totalWithSdkBytes).toBeLessThanOrEqual(LIMIT_BYTES);
    }
  }, 300_000);
});
