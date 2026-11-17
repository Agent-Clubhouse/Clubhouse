import { test } from '@playwright/test';
import { probePinnedApprovals } from './approval-geometry-chat';

// Probe (#3606): where Allow sits on the pinned card across consecutive requests. Not run for a layout fix; read its table.
test.setTimeout(240_000);
test('claude: the pinned card keeps Allow in one place across three requests at three sizes', async () => {
  await probePinnedApprovals('claude');
});
