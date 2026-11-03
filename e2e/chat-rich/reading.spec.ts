import { test, expect } from '@playwright/test';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Reading a busy chat (#2664): a stack of tool calls folds to one row whose
 * detail isn't built until it opens, and Latest stays away at the bottom.
 * Only a user scroll stops a view following the bottom (#2748).
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

test('claude: a wheel scroll pauses following, nothing else does, and sending returns to the bottom', async () => {
  const longReply = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a reply long enough to scroll.`).join('\n\n');
  session = await openRichChat({
    cli: 'claude',
    script: () => ({
      description: 'long replies',
      turns: [{ steps: [{ type: 'text', text: longReply }] }, { steps: [{ type: 'text', text: 'Short reply.' }] }],
    }),
  });
  const dom = chatDom(session.window);
  await session.send('Write a lot.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  const page = session.window;
  const stream = page.getByTestId('chat-stream');
  const latest = page.getByTestId('chat-window-latest');
  const distance = () => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(distance).toBeLessThanOrEqual(16);
  await expect(latest).toHaveCount(0);

  // A move no one scrolled goes back to the bottom, and Latest stays away.
  await stream.evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(distance).toBeLessThanOrEqual(16);
  await expect(latest).toHaveCount(0);

  // The real wheel pauses it, and it stays where the reader put it.
  await stream.hover({ position: { x: 24, y: 8 } });
  await page.mouse.wheel(0, -600);
  await expect(latest).toHaveCount(1);
  await expect.poll(distance).toBeGreaterThan(16);

  await session.send('Now a short one.');
  await expect(dom.turnFooters).toHaveCount(2, { timeout: TURN_TIMEOUT });
  await expect.poll(distance).toBeLessThanOrEqual(16);
  await expect(latest).toHaveCount(0);
});
