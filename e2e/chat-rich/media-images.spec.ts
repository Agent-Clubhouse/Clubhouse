import { test, expect } from '@playwright/test';
import * as path from 'path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectImageLoaded, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Rich media (#2480 area 1). One Claude tool result with an image becomes a
 * stored thumbnail that opens in the viewer (the Phase 1 example). Then one
 * shared Claude launch covers the other image shapes: Read's
 * `tool_use_result` image, Markdown images inside and outside the project, a
 * missing one, and the viewer's fit, actual size, Escape and focus return.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

test('claude: an image in a tool result shows as a thumbnail and opens in the viewer', async () => {
  session = await openRichChat({
    cli: 'claude',
    script: {
      description: 'Read returns a PNG',
      turns: [{ steps: [{ type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' } }, { type: 'text', text: 'That is a gradient.' }] }],
    },
  });
  const dom = chatDom(session.window);
  await session.send('Look at the image.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  // Main stored the bytes and the renderer asks for them by reference, never by path.
  const thumb = dom.toolImages.locator('[data-testid="chat-image-thumb"]');
  await expect(thumb).toHaveCount(1, { timeout: TURN_TIMEOUT });
  await expect(thumb).toHaveAttribute('data-media-ref', /^[0-9a-f]{64}\.png$/);
  await expectImageLoaded(thumb);

  await thumb.click();
  await expect(dom.lightbox).toBeVisible();
  await expectImageLoaded(dom.lightboxImage);
  await dom.lightbox.getByRole('button', { name: 'Close' }).click();
  await expect(dom.lightbox).toHaveCount(0);

  await session.expectScriptComplete();
});

test.describe('claude: images in one session', () => {
  // One launch for the whole group (the plan's main lever on shard time): each test sends the next turn.
  test.describe.configure({ mode: 'serial' });

  let shared: RichChat;
  let insidePath = '';
  let outsidePath = '';
  let missingPath = '';
  test.beforeAll(async () => {
    shared = await openRichChat({
      cli: 'claude',
      projectFiles: { [path.join('shots', 'inside.png')]: { copy: CHAT_MEDIA.png } },
      outsideFiles: { 'outside.png': { copy: CHAT_MEDIA.png } },
      script: ({ projectDir, outsideDir }) => {
        insidePath = path.join(projectDir, 'shots', 'inside.png');
        outsidePath = path.join(outsideDir, 'outside.png');
        missingPath = path.join(projectDir, 'shots', 'missing.png');
        return {
          description: 'Read returns an image without an image block; a reply with Markdown images',
          turns: [
            { prompt: 'Read the image.', steps: [{ type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' }, variant: 'read-result' }, { type: 'text', text: 'Read it.' }] },
            {
              prompt: 'Show me the screenshots.',
              steps: [{
                type: 'text',
                text: [
                  `In the project: ${md.image('inside shot', insidePath)}`,
                  `Outside it: ${md.image('outside shot', outsidePath)}`,
                  `Not written yet: ${md.image('missing shot', missingPath)}`,
                ].join('\n\n'),
              }],
            },
          ],
        };
      },
    });
  });
  test.afterAll(async () => {
    await shared?.close();
  });

  test('a Read result image with no image block still shows as a thumbnail', async () => {
    const dom = chatDom(shared.window);
    await shared.send('Read the image.');
    await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

    const thumb = dom.toolImages.locator('[data-testid="chat-image-thumb"]');
    await expect(thumb).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(thumb).toHaveAttribute('data-media-ref', /^[0-9a-f]{64}\.png$/);
    await expectImageLoaded(thumb);
  });

  test('Markdown images inside and outside the project show; a missing one says why', async () => {
    const dom = chatDom(shared.window);
    await shared.send('Show me the screenshots.');
    await expect(dom.turnFooters).toHaveCount(2, { timeout: TURN_TIMEOUT });

    // Main resolved each path and stored a copy: the thumbnail names the stored media, never the path.
    for (const alt of ['inside shot', 'outside shot']) {
      const thumb = dom.markdownImage(alt);
      await expect(thumb).toBeVisible({ timeout: TURN_TIMEOUT });
      await expect(thumb).toHaveAttribute('data-chat-media-ref', /^[0-9a-f]{64}\.png$/);
      await expectImageLoaded(thumb);
    }
    await expect(dom.markdownImageNotShown).toHaveCount(1, { timeout: TURN_TIMEOUT });
    await expect(dom.markdownImageNotShown).toContainText('missing shot');
    await expect(dom.markdownImageNotShown).toContainText('Image not found.');
  });

  test('the viewer fits, toggles actual size, closes on Escape and returns focus', async () => {
    const dom = chatDom(shared.window);
    const thumb = dom.markdownImage('inside shot');
    await thumb.click();
    await expect(dom.lightbox).toBeVisible();
    await expectImageLoaded(dom.lightboxImage);

    const toggle = dom.lightbox.getByRole('button', { name: 'Actual size' });
    await toggle.click();
    await expect(dom.lightbox.getByRole('button', { name: 'Fit to window' })).toBeVisible();
    await dom.lightbox.getByRole('button', { name: 'Fit to window' }).click();
    await expect(toggle).toBeVisible();

    await shared.window.keyboard.press('Escape');
    await expect(dom.lightbox).toHaveCount(0);
    await expect(thumb).toBeFocused();

    await shared.expectScriptComplete();
  });
});

test('codex: a viewed image and a generated one both show as thumbnails', async () => {
  session = await openRichChat({
    cli: 'codex',
    // Main reads an imageView's file only inside the agent's folders.
    projectFiles: { [path.join('shots', 'view.png')]: { copy: CHAT_MEDIA.png } },
    script: ({ projectDir }) => ({
      description: 'imageView of a project file, then imageGeneration with base64 bytes',
      turns: [{
        steps: [
          { type: 'image-tool', image: { path: path.join(projectDir, 'shots', 'view.png'), mimeType: 'image/png' }, variant: 'view' },
          { type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' }, variant: 'generated' },
          { type: 'text', text: 'Viewed one, made one.' },
        ],
      }],
    }),
  });
  const dom = chatDom(session.window);
  await session.send('View the screenshot and draw another.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  await expect(dom.imageThumbs).toHaveCount(2, { timeout: TURN_TIMEOUT });
  for (const thumb of await dom.imageThumbs.all()) {
    await expect(thumb).toHaveAttribute('data-media-ref', /^[0-9a-f]{64}\.png$/);
    await expectImageLoaded(thumb);
  }
  await expect(dom.imageUnavailable).toHaveCount(0);

  await session.expectScriptComplete();
});

test('copilot: asset and inline images show as thumbnails; an omitted one says unavailable', async () => {
  session = await openRichChat({
    cli: 'copilot',
    script: {
      description: 'binaryResultsForLlm: an asset in the session journal, inline bytes, and bytes Copilot left out',
      turns: [{
        steps: [
          { type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' }, variant: 'asset' },
          { type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' }, variant: 'inline' },
          { type: 'image-tool', image: { path: CHAT_MEDIA.png, mimeType: 'image/png' }, variant: 'omitted' },
          { type: 'text', text: 'Three images.' },
        ],
      }],
    },
  });
  const dom = chatDom(session.window);
  await session.send('Show me the images.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  // The asset resolved from COPILOT_HOME's journal (its id is the bytes' sha256), and inline bytes were stored.
  await expect(dom.imageThumbs).toHaveCount(2, { timeout: TURN_TIMEOUT });
  for (const thumb of await dom.imageThumbs.all()) {
    await expect(thumb).toHaveAttribute('data-media-ref', /^[0-9a-f]{64}\.png$/);
    await expectImageLoaded(thumb);
  }
  await expect(dom.imageUnavailable).toHaveCount(1);
  await expect(dom.imageUnavailable).toHaveText('Image unavailable');

  await session.expectScriptComplete();
});
