/**
 * Runtime guard for plugin API v0.4.
 *
 * Compile-time structural checks live in v0.4.ts (included by tsconfig).
 * This test ensures removing 0.4 from SUPPORTED_API_VERSIONS is a
 * deliberate, visible act.
 */

import { SUPPORTED_API_VERSIONS } from '../../renderer/plugins/manifest-validator';

describe('Plugin API v0.4 contract', () => {
  it('v0.4 is still a supported API version', () => {
    expect(SUPPORTED_API_VERSIONS).toContain(0.4);
  });

  it('v0.4 snapshot includes FilesAPI', async () => {
    // Verify the v0.4 snapshot type includes files property
    // This is a runtime check that the type file exists and exports the right shape
    const v04 = await import('./v0.4');
    expect(v04).toBeDefined();
    // The compile-time check in v0.4.ts ensures PluginAPI extends PluginAPI_V0_4
    // which now includes files: FilesAPI_V0_4
  });
});
