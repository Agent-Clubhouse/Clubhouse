import { describe, expect, it } from 'vitest';

describe('standard runtime boundary', () => {
  it('clears inherited real CLI and runtime opt-ins before test collection', () => {
    for (const key of [
      'CLUBHOUSE_RECORD_COPILOT_SDK', 'CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK',
      'CLUBHOUSE_FAKE_MODEL_SMOKE', 'CLUBHOUSE_CHAT_HANDSHAKE_SMOKE',
      'CLUBHOUSE_LIVE_DRIVER_SMOKE',
    ]) expect(process.env[key]).toBeUndefined();
  });
});
