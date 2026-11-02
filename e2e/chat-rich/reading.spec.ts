import { test, expect } from '@playwright/test';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Reading a busy chat (#2664): a stack of tool calls folds to one row whose
 * detail isn't built until it opens, and Latest stays away at the bottom.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

test('claude: tool calls fold to one row that opens, and Latest stays away at the bottom', async () => {
  session = await openRichChat({
    cli: 'claude',
    script: () => ({
      description: 'two commands, then a reply',
      turns: [{
        steps: [
          { type: 'command', command: 'echo first', output: 'first\n' },
          { type: 'command', command: 'echo second', output: 'second\n' },
          { type: 'text', text: 'Both ran.' },
        ],
      }],
    }),
  });
  const dom = chatDom(session.window);
  await session.send('Run two commands.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  const toggle = session.window.getByTestId('chat-group-toggle');
  await expect(toggle).toHaveText('Made 2 tool calls');
  const cards = session.window.getByTestId('chat-command-card');
  await expect(cards).toHaveCount(0);
  await expect(session.window.getByTestId('chat-window-latest')).toHaveCount(0);

  await toggle.click();
  await expect(cards).toHaveCount(2);
  await expect(session.window.getByTestId('chat-window-latest')).toHaveCount(0);
});
