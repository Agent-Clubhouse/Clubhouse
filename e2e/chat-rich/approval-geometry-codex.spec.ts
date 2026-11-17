import { test } from '@playwright/test';
import { probePinnedApprovals } from './approval-geometry-chat';

// Probe (#3606): the same, with Codex's four options per request.
test.setTimeout(240_000);
test('codex: the pinned card keeps Allow in one place across three requests at three sizes', async () => {
  await probePinnedApprovals('codex');
});
