import { test, expect } from '@playwright/test';
import { coalesceUpdateTexts } from '../../src/shared/chat/coalesce';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * The queue (#2413) and helper message merging (#2414), #2480 area 6.
 *
 * Claude steers natively: Steer, Queue and a parent's helper updates all go
 * to the CLI mid-turn, as `user` messages with a priority. Its turns are held
 * (they run until Stop) and list exactly the steers the CLI must receive, so
 * an extra, missing or merged message is a replay mismatch.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

/** A helper's report as message_parent words it. */
const fromHelper = (name: string, text: string) => `[FROM HELPER:${name} (durable_${name})] ${text}`;

test('claude: 30 queued messages stay in a capped list, the composer stays usable, and nothing offers a remove', async () => {
  const queued = Array.from({ length: 30 }, (_, i) => `Queued message ${i + 1}`);
  session = await openRichChat({
    cli: 'claude',
    script: {
      description: '30 messages queued on Claude\'s own queue during a held turn',
      turns: [{ prompt: 'Start.', steps: [{ type: 'text', text: 'Working.' }], end: 'held', steers: queued.map((text) => ({ priority: 'later' as const, text })) }],
    },
  });
  const { window, chat } = session;
  const dom = chatDom(window);
  await session.send('Start.');
  await expect(chat).toHaveAttribute('data-state', 'running', { timeout: TURN_TIMEOUT });

  for (const text of queued) await session.queue(text);
  await expect(dom.queueItems).toHaveCount(30, { timeout: TURN_TIMEOUT });
  await expect(dom.queueToggle).toContainText('30');

  // The list scrolls within its cap, and the composer stays on screen and takes input.
  const list = await dom.queueList.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(list.client).toBeLessThanOrEqual(155);
  expect(list.scroll).toBeGreaterThan(list.client);
  const box = window.getByRole('textbox', { name: 'Message' });
  await expect(dom.composer).toBeInViewport();
  await expect(box).toBeInViewport();
  await box.fill('still typing');
  await expect(box).toHaveValue('still typing');
  await box.fill('');

  // Folding it leaves the header, and the composer where it was.
  await dom.queueToggle.click();
  await expect(dom.queueList).toHaveCount(0);
  await expect(box).toBeInViewport();
  await dom.queueToggle.click();
  await expect(dom.queueItems).toHaveCount(30);

  // Claude already holds these messages, so there is nothing to take back.
  await expect(dom.queueRemove).toHaveCount(0);
  await expect(dom.queueClear).toHaveCount(0);

  await dom.stop.click();
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  // Every queued message reached the CLI, in order, each on its own.
  await session.expectScriptComplete();
});

test('claude: a burst of helper updates becomes one steer, and user steers are never merged', async () => {
  const userSteers = ['Use tabs, not spaces.', 'Also run the linter.'];
  const updates = [
    ...Array.from({ length: 9 }, (_, i) => fromHelper(`helper-${i + 1}`, `Step ${i + 1} done.`)),
    '[Clubhouse] Helper helper-10 is ready.',
  ];
  session = await openRichChat({
    cli: 'claude',
    script: {
      description: 'two user steers, then ten helper updates in one steer',
      turns: [{
        prompt: 'Start.',
        steps: [{ type: 'text', text: 'Working.' }],
        end: 'held',
        steers: [...userSteers.map((text) => ({ text })), { text: coalesceUpdateTexts(updates) }],
      }],
    },
  });
  const { window, chat } = session;
  const dom = chatDom(window);
  await session.send('Start.');
  await expect(chat).toHaveAttribute('data-state', 'running', { timeout: TURN_TIMEOUT });

  // Each user steer goes at once, on its own.
  const steered = dom.userMessages.and(window.locator('[data-delivery="steer"]'));
  for (const text of userSteers) await session.send(text);
  await expect(steered.and(window.locator('[data-source="user"]'))).toHaveCount(2, { timeout: TURN_TIMEOUT });

  // The updates wait out the batching window, then go as one steer.
  await session.sendHelperUpdates(updates);
  const fromAgents = steered.and(window.locator('[data-source="mcp"]'));
  await expect(fromAgents).toHaveCount(1, { timeout: TURN_TIMEOUT });
  for (const text of updates) await expect(fromAgents).toContainText(text);
  for (const text of userSteers) await expect(fromAgents).not.toContainText(text);

  await dom.stop.click();
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  // The CLI got the two user steers and then exactly one merged update.
  await session.expectScriptComplete();
});
