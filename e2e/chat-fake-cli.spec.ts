import { test, expect } from '@playwright/test';
import { installFakeClis, type FakeClis } from './chat-fake-cli';
import { launchApp } from './launch';

/**
 * Chat E2E against fake CLIs: zero tokens, real protocol traffic.
 *
 * Marked fixme until the Chat runtime and its experimental setting land
 * (docs/structured-chat-research.md, Phase 0). The wiring below is live:
 * `installFakeClis` puts fixture-replaying `claude`, `codex` and `copilot`
 * first on the app's PATH, and each report says whether the app drove the
 * whole fixture. Fill in the UI steps when the chat view exists.
 */
test.describe('chat over fake CLIs', () => {
  let fakes: FakeClis | undefined;

  test.afterEach(async () => {
    await fakes?.cleanup();
  });

  for (const cli of ['claude', 'codex', 'copilot'] as const) {
    test.fixme(`${cli}: a multi-turn chat replays its fixture end to end`, async () => {
      fakes = await installFakeClis({ [cli]: 'multi-turn' });
      const { electronApp } = await launchApp({ env: fakes.env });
      try {
        // TODO(chat): enable Chat for the provider, open a durable agent,
        // send the fixture's two prompts and assert both replies render.
        const report = await fakes.report(cli);
        expect(report.mismatch).toBeNull();
        expect(report.complete).toBe(true);
      } finally {
        await electronApp.close();
      }
    });
  }
});
