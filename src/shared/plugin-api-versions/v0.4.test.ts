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
});
