import { test, expect } from '@playwright/test';
import { CHAT_MEDIA } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectImageLoaded, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Rich media (#2480 area 1). Phase 1 example: one Claude tool result with an
 * image becomes a stored thumbnail that opens in the viewer. Phase 2 adds the
 * Codex and Copilot shapes, Markdown images and the missing-image cases.
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
