import { test, expect } from '@playwright/test';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Block structure from the composer to the sent bubble (#3619): a list can start
 * on a line after text, and a blank line or a list in a sent message keeps its
 * own block. jsdom has no layout, so the height checks need the real browser.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

test('claude: a list starts after text and sent messages keep blank lines and lists as blocks', async () => {
  session = await openRichChat({
    cli: 'claude',
    script: () => ({
      description: 'two short replies',
      turns: [{ steps: [{ type: 'text', text: 'One.' }] }, { steps: [{ type: 'text', text: 'Two.' }] }],
    }),
  });
  const { window, chat } = session;
  const dom = chatDom(window);
  const composer = chat.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('');
  await expect(composer).toHaveAttribute('data-empty', 'true');

  // Two soft returns: a blank paragraph, kept after sending.
  await composer.pressSequentially('first');
  await composer.press('Shift+Enter');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('second');
  await composer.press('Enter');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  const body = dom.userMessages.nth(0).getByTestId('chat-you-body');
  await expect(body.locator(':scope > div')).toHaveText(['first', '', 'second']);
  const rects = await body.locator(':scope > div').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(rects[1].height).toBeGreaterThan(0);
  // The gap between the two lines holds the blank block.
  expect(rects[2].top - rects[0].bottom).toBeGreaterThanOrEqual(rects[1].height - 1);

  // A marker typed on a new line after text starts a list; the text above stays a paragraph.
  await expect(composer).toHaveAttribute('data-empty', 'true');
  await composer.pressSequentially('intro');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('- item');
  await expect(composer.locator('ul > li')).toHaveText(['item']);
  await expect(composer.locator(':scope > p')).toHaveText(['intro']);
  await composer.press('Shift+Enter');
  await composer.pressSequentially('more');
  await expect(composer.locator('ul > li')).toHaveText(['item', 'more']);
  await composer.press('Enter');
  await expect(dom.turnFooters).toHaveCount(2, { timeout: TURN_TIMEOUT });

  // Paragraph then list are distinct blocks in the sent bubble.
  const listBody = dom.userMessages.nth(1).getByTestId('chat-you-body');
  await expect(listBody.locator(':scope > div')).toHaveText(['intro']);
  await expect(listBody.locator(':scope > ul > li')).toHaveText(['item', 'more']);
  const [paragraph, list] = await Promise.all([
    listBody.locator(':scope > div').evaluate((el) => el.getBoundingClientRect()),
    listBody.locator(':scope > ul').evaluate((el) => el.getBoundingClientRect()),
  ]);
  expect(list.top).toBeGreaterThanOrEqual(paragraph.bottom - 1);

  await session.expectScriptComplete();
});
