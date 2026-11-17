import { test } from '@playwright/test';
import { expectPinnedApprovalsAnchored } from './approval-geometry-chat';

// #3606: the pinned card's Allow and Decline stay in one place across consecutive requests, with Codex's four options.
test.setTimeout(240_000);
test('codex: the pinned card keeps Allow and Decline in one place across three requests at three sizes', async () => {
  await expectPinnedApprovalsAnchored('codex');
});
