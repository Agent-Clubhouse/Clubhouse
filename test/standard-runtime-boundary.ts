// Standard tests must not inherit a caller's opt-in to real CLI or runtime QA.
// Explicit QA runs use vitest.live-qa.config.ts, which does not load this file.
for (const key of [
  'CLUBHOUSE_RECORD_COPILOT_SDK', 'CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK',
  'CLUBHOUSE_FAKE_MODEL_SMOKE', 'CLUBHOUSE_CHAT_HANDSHAKE_SMOKE',
  'CLUBHOUSE_LIVE_DRIVER_SMOKE',
]) delete process.env[key];
