import { test, expect } from '@playwright/test';
import * as path from 'path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectCanvasPainted, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * File chips (#2480 area 2). Phase 1 example: a PDF outside the project,
 * named in the agent's reply, becomes a chip whose preview draws page 1 with
 * pdf.js. Phase 2 adds paging, `:line:col`, spaces and the reasons a file
 * can't be shown.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

test('claude: a PDF outside the project becomes a chip that previews page 1', async () => {
  let pdfPath = '';
  session = await openRichChat({
    cli: 'claude',
    outsideFiles: { 'report.pdf': { copy: CHAT_MEDIA.pdf } },
    script: ({ outsideDir }) => {
      pdfPath = path.join(outsideDir, 'report.pdf');
      return { description: 'a reply naming a PDF outside the project', turns: [{ steps: [{ type: 'text', text: `The report is in ${md.path(pdfPath)}.` }] }] };
    },
  });
  const dom = chatDom(session.window);
  await session.send('Where is the report?');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  // A chip only once main has confirmed the file and its kind.
  const chip = dom.fileChip(pdfPath);
  await expect(chip).toHaveAttribute('data-chat-file', 'pdf', { timeout: TURN_TIMEOUT });
  await chip.click();

  await expect(dom.filePreview).toBeVisible();
  const page1 = dom.pdfCanvas(1, 2);
  await expect(page1).toBeVisible({ timeout: TURN_TIMEOUT });
  await expectCanvasPainted(page1);
  await expect(dom.pdfPageLabel).toHaveText('Page 1 of 2');

  await session.window.keyboard.press('Escape');
  await expect(dom.filePreview).toHaveCount(0);

  await session.expectScriptComplete();
});
