import { test, expect } from '@playwright/test';
import * as path from 'path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, openRichChat, richChatCalls, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Rich content flag off (#2480 area 7). The same rich shapes as areas 1 to 4
 * (tool images, file chips, Markdown images, media, GitHub links) with
 * `richChatContent` off render as before: plain text and code spans, with no
 * chips, thumbnails, cards or tokens. Main's rich `chat:*` handlers count
 * every call, and must see none.
 */

let session: RichChat | undefined;
test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

/** Anything rich content adds to the transcript. */
const RICH_SELECTOR = [
  '[data-chat-file]', '[data-chat-file-unavailable]', '[data-chat-path]',
  '[data-chat-media]', '[data-chat-media-card]', '[data-chat-media-ref]',
  '[data-gh-token]', '.chat-rich-link',
  '[data-testid="chat-tool-images"]', '[data-testid="chat-image-thumb"]', '[data-testid="chat-image-unavailable"]',
].join(', ');

const PR_URL = 'https://github.com/Agent-Clubhouse/Clubhouse/pull/2482';

test('claude: with rich content off, rich shapes stay plain text and main gets no rich calls', async () => {
  const written: Record<string, string> = {};
  session = await openRichChat({
    cli: 'claude',
    flags: { richChatContent: false },
    projectFiles: {
      'notes.txt': 'one\ntwo\nthree\n',
      'with space/plan.md': '# Plan\n',
      'diagram.png': { copy: CHAT_MEDIA.png },
      'tone.wav': { copy: CHAT_MEDIA.wav },
      'clip.webm': { copy: CHAT_MEDIA.webm },
    },
    outsideFiles: { 'report.pdf': { copy: CHAT_MEDIA.pdf } },
    script: ({ projectDir, outsideDir }) => {
      Object.assign(written, {
        pdf: path.join(outsideDir, 'report.pdf'),
        notes: path.join(projectDir, 'notes.txt'),
        spaced: path.join(projectDir, 'with space', 'plan.md'),
        wav: path.join(projectDir, 'tone.wav'),
        webm: path.join(projectDir, 'clip.webm'),
      });
      const image = { path: CHAT_MEDIA.png, mimeType: 'image/png' };
      return {
        description: 'every rich shape, replayed with rich content off',
        turns: [
          {
            steps: [
              { type: 'image-tool', image },
              { type: 'image-tool', image, variant: 'read-result' },
              {
                type: 'text',
                text: [
                  `The report is ${md.path(written.pdf)} and the notes are ${md.path(written.notes, 2, 1)}.`,
                  `The plan is ${md.path(written.spaced)}.`,
                  `Listen to ${md.path(written.wav)} and watch ${md.path(written.webm)}.`,
                  `See Agent-Clubhouse/Clubhouse#2480 and ${PR_URL}.`,
                  md.image('diagram', path.join(projectDir, 'diagram.png')),
                ].join('\n\n'),
              },
            ],
          },
          { prompt: 'Thanks.', steps: [{ type: 'text', text: 'Done.' }] },
        ],
      };
    },
  });
  const { window, electronApp } = session;
  const dom = chatDom(window);

  await session.send('Show me everything.');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  // The text is all there, as code spans and plain links.
  const reply = dom.agentMessages.filter({ hasText: 'The report is' });
  await expect(reply).toHaveCount(1);
  for (const p of [written.pdf, `${written.notes}:2:1`, written.spaced, written.wav, written.webm]) {
    await expect(reply.locator('code', { hasText: p })).toHaveCount(1);
  }
  await expect(reply).toContainText('Agent-Clubhouse/Clubhouse#2480');
  await expect(reply.locator(`a[href="${PR_URL}"]`)).toHaveText(PR_URL);

  // Clicking a path does nothing rich.
  await reply.locator('code', { hasText: written.pdf }).click();
  await expect(dom.filePreview).toHaveCount(0);
  await expect(dom.lightbox).toHaveCount(0);

  // A second turn: the renderer's invokes reach main in order, so any rich
  // call the first reply made arrived before this prompt did.
  await session.send('Thanks.');
  await expect(dom.turnFooters).toHaveCount(2, { timeout: TURN_TIMEOUT });
  await session.expectScriptComplete();

  await expect(window.locator(RICH_SELECTOR)).toHaveCount(0);
  const calls = await richChatCalls(electronApp);
  expect(Object.keys(calls).length).toBeGreaterThan(0);
  expect(calls).toEqual(Object.fromEntries(Object.keys(calls).map((c) => [c, 0])));

  // The counter counts: a direct call is refused because the flag is off, and counted.
  const refused = await window.evaluate((p) => {
    const chat = (window as unknown as { clubhouse: { chat: { statPaths(agentId: string, paths: string[]): Promise<unknown> } } }).clubhouse.chat;
    return chat.statPaths('flag-off-check', [p]).then(() => '', (e: Error) => e.message);
  }, written.pdf);
  expect(refused).toContain('Rich chat content is off');
  expect((await richChatCalls(electronApp))['chat:stat-paths']).toBe(1);
});
