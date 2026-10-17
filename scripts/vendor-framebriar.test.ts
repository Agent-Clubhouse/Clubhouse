/**
 * The vendored Framebriar SDK (src/main/vendor/framebriar) must match its pinned manifest:
 * nobody edits vendored files in place. Re-vendor with
 * `npm run framebriar:vendor -- ~/source/framebriar`; compare against upstream with
 * `npm run framebriar:check -- --from ~/source/framebriar`.
 */
import { describe, expect, it } from 'vitest';

describe('vendored Framebriar SDK', () => {
  it('matches the pinned manifest', async () => {
    const { checkLocal } = await import('./vendor-framebriar.mjs');
    const { manifest, problems } = checkLocal();
    expect(problems).toEqual([]);
    expect(manifest.repo).toBe('https://github.com/masra91/framebriar');
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining([
      'adapters/node/index.mjs', 'adapters/browser/telemetry.mjs', 'adapters/browser/otel-exporter.mjs', 'src/protocol.mjs',
    ]));
  });
});
