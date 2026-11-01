import { test, expect, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CHAT_MEDIA, md } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatDom, expectCanvasPainted, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * File chips (#2480 area 2). A path an agent names becomes a chip once main
 * confirms the file, wherever it is, and its preview shows what the file
 * holds: Monaco at `:line:col` for text, pdf.js pages for a PDF, or why it
 * can't. The Phase 1 example opens one PDF on its own launch; the Phase 2
 * Claude cases share one launch and one reply that names every file. Codex
 * has its own launch, for a path in command output.
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

/** A canvas's pixels as one string, to tell two drawn pages apart. */
function canvasPixels(canvas: Locator): Promise<string> {
  return canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
}

/** Lines of the project's `src/app.ts`; the reply points at line 7, column 3. */
const APP_TS = Array.from({ length: 12 }, (_, i) => (i === 6 ? '  totalLine7();' : `// line ${i + 1}`)).join('\n') + '\n';
/** Over the 16 MB PDF preview cap. Made sparse with `truncate` after seeding. */
const BIG_PDF_BYTES = 17 * 1024 * 1024;
/** Over the 512 KB text preview cap: text is never too large, it's cut short. */
const BIG_LOG = 'logline\n'.repeat(80 * 1024);
/** Named `.pdf`, but bytes with NULs and no PDF header: neither a PDF nor text. */
const SCAN_PDF = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256));
/** A PDF header over printable garbage: a PDF to the sniffer (no NUL), unreadable to pdf.js. */
const BROKEN_PDF = `%PDF-1.7\n${'not really a pdf '.repeat(64)}\n`;

test.describe('claude: file chips in one reply', () => {
  test.describe.configure({ mode: 'serial' });

  let chat: RichChat;
  let p: Record<'app' | 'util' | 'todo' | 'bigLog' | 'plan' | 'report' | 'bigPdf' | 'scan' | 'broken' | 'gone', string>;

  test.beforeAll(async () => {
    chat = await openRichChat({
      cli: 'claude',
      projectFiles: {
        [path.join('src', 'app.ts')]: APP_TS,
        [path.join('src', 'util.ts')]: 'export const UTIL_MARKER = 1;\n',
        [path.join('notes dir', 'todo list.md')]: '# TODO_MARKER\n',
        [path.join('src', 'big.log')]: BIG_LOG,
      },
      outsideFiles: {
        [path.join('My Docs', 'plan one.txt')]: 'PLAN_MARKER\n',
        'report.pdf': { copy: CHAT_MEDIA.pdf },
        'big.pdf': '%PDF-1.4\n',
        'scan.pdf': SCAN_PDF,
        'broken.pdf': BROKEN_PDF,
      },
      script: ({ projectDir, outsideDir }) => {
        p = {
          app: path.join(projectDir, 'src', 'app.ts'),
          util: path.join(projectDir, 'src', 'util.ts'),
          todo: path.join(projectDir, 'notes dir', 'todo list.md'),
          bigLog: path.join(projectDir, 'src', 'big.log'),
          plan: path.join(outsideDir, 'My Docs', 'plan one.txt'),
          report: path.join(outsideDir, 'report.pdf'),
          bigPdf: path.join(outsideDir, 'big.pdf'),
          scan: path.join(outsideDir, 'scan.pdf'),
          broken: path.join(outsideDir, 'broken.pdf'),
          gone: path.join(outsideDir, 'gone.txt'),
        };
        return {
          description: 'a command whose output names a file, then a reply naming files of every kind',
          turns: [{
            steps: [
              { type: 'command', command: 'ls src', output: `${p.util}\n` },
              {
                type: 'text',
                text: [
                  'Here is what I found:',
                  '',
                  `- The entry point is ${md.path(p.app, 7, 3)}.`,
                  `- Your list is in ${md.quotedPath(p.todo)}, and the plan is ${md.path(p.plan)}.`,
                  `- The report is ${md.path(p.report)}, the full export is ${md.path(p.bigPdf)} and the log is ${md.path(p.bigLog)}.`,
                  `- The scans are ${md.path(p.scan)} and ${md.path(p.broken)}.`,
                  `- I couldn't find ${md.path(p.gone)}.`,
                ].join('\n'),
              },
            ],
          }],
        };
      },
    });
    // Grown after seeding: sparse on Linux, zero-filled on Windows. Main reads only its head.
    await fs.promises.truncate(p.bigPdf, BIG_PDF_BYTES);
    await chat.send('What files are there?');
    await expect(chatDom(chat.window).turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  });

  test.afterAll(async () => {
    await chat?.close();
  });

  test('a path with spaces chips whole, as a code span and quoted in prose', async () => {
    const dom = chatDom(chat.window);
    await expect(dom.fileChip(p.plan)).toHaveAttribute('data-chat-file', 'text', { timeout: TURN_TIMEOUT });
    await expect(dom.fileChip(p.todo)).toHaveAttribute('data-chat-file', 'text');
    await expect(dom.fileChip(p.todo)).toHaveText(p.todo);
  });

  test('a text file outside the project previews, and Open in Files says it is in no project', async () => {
    const dom = chatDom(chat.window);
    const chip = dom.fileChip(p.plan);
    await expect(chip).toHaveAttribute('data-chat-file', 'text', { timeout: TURN_TIMEOUT });
    await chip.click();
    const text = dom.filePreview.getByTestId('chat-file-preview-text');
    await expect(text.locator('.view-lines')).toContainText('PLAN_MARKER', { timeout: TURN_TIMEOUT });

    await dom.filePreview.getByRole('button', { name: 'Open in Files' }).click();
    await expect(dom.filePreview.getByRole('alert')).toHaveText('That file is not in an open project');
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);
  });

  test('a PDF pages with Next and Previous', async () => {
    const dom = chatDom(chat.window);
    const chip = dom.fileChip(p.report);
    await expect(chip).toHaveAttribute('data-chat-file', 'pdf', { timeout: TURN_TIMEOUT });
    await chip.click();
    const previous = dom.pdfPreview.getByRole('button', { name: 'Previous' });
    const next = dom.pdfPreview.getByRole('button', { name: 'Next' });
    await expect(dom.pdfCanvas(1, 2)).toBeVisible({ timeout: TURN_TIMEOUT });
    await expect(previous).toBeDisabled();
    await expectCanvasPainted(dom.pdfCanvas(1, 2));
    const page1 = await canvasPixels(dom.pdfCanvas(1, 2));

    await next.click();
    await expect(dom.pdfPageLabel).toHaveText('Page 2 of 2');
    await expect(next).toBeDisabled();
    // The label switches before pdf.js draws: wait for pixels that aren't page 1's.
    await expect.poll(() => canvasPixels(dom.pdfCanvas(2, 2)), { timeout: TURN_TIMEOUT }).not.toBe(page1);
    await expectCanvasPainted(dom.pdfCanvas(2, 2));

    await previous.click();
    await expect(dom.pdfPageLabel).toHaveText('Page 1 of 2');
    await expect.poll(() => canvasPixels(dom.pdfCanvas(1, 2)), { timeout: TURN_TIMEOUT }).toBe(page1);
    await expect(previous).toBeDisabled();
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);
  });

  test('a PDF over the cap says it is too large, and a long text file shows its start', async () => {
    const dom = chatDom(chat.window);
    const big = dom.fileChip(p.bigPdf);
    await expect(big).toHaveAttribute('data-chat-file', 'pdf', { timeout: TURN_TIMEOUT });
    await expect(big).toHaveAttribute('title', /Too large to preview/);
    await big.click();
    await expect(dom.filePreview.getByTestId('chat-file-preview-none')).toHaveText('This file is too large to preview here.', { timeout: TURN_TIMEOUT });
    await expect(dom.pdfPreview).toHaveCount(0);
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);

    const log = dom.fileChip(p.bigLog);
    await expect(log).toHaveAttribute('data-chat-file', 'text');
    await log.click();
    await expect(dom.filePreview.getByTestId('chat-file-preview-note')).toHaveText('Showing the first 512 KB. Open it in Files to see the rest.', { timeout: TURN_TIMEOUT });
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);
  });

  test('a missing file stays a muted chip that says why', async () => {
    const dom = chatDom(chat.window);
    const muted = dom.mutedChip(p.gone);
    await expect(muted).toHaveAttribute('data-chat-file-unavailable', 'missing', { timeout: TURN_TIMEOUT });
    await expect(muted).toHaveAttribute('title', 'File not found');
    await expect(dom.fileChip(p.gone)).toHaveCount(0);
  });

  test('a binary-ish file named .pdf is never shown as text', async () => {
    const dom = chatDom(chat.window);
    const textPreview = dom.filePreview.getByTestId('chat-file-preview-text');

    // NULs and no PDF header: no preview at all.
    const scan = dom.fileChip(p.scan);
    await expect(scan).toHaveAttribute('data-chat-file', 'other', { timeout: TURN_TIMEOUT });
    await scan.click();
    await expect(dom.filePreview.getByTestId('chat-file-preview-none')).toHaveText('No preview for this kind of file.', { timeout: TURN_TIMEOUT });
    await expect(textPreview).toHaveCount(0);
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);

    // A PDF header and no NULs: still a PDF, which pdf.js can't read, not `%PDF-` text.
    const broken = dom.fileChip(p.broken);
    await expect(broken).toHaveAttribute('data-chat-file', 'pdf');
    await broken.click();
    await expect(dom.filePreview.getByTestId('chat-file-preview-pdf-error')).toHaveText("Couldn't read this PDF.", { timeout: TURN_TIMEOUT });
    await expect(textPreview).toHaveCount(0);
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);
  });

  test('a path in command output chips too', async () => {
    const dom = chatDom(chat.window);
    const card = chat.window.getByTestId('chat-command-card');
    await expect(card).toHaveAttribute('data-status', 'completed');
    // A finished command is collapsed: its output shows once opened.
    await card.getByRole('button', { name: /^Expand command/ }).click();
    const chip = card.locator('pre').locator(`[data-chat-file="text"]`);
    await expect(chip).toHaveAttribute('data-chat-path', p.util, { timeout: TURN_TIMEOUT });
    await chip.click();
    await expect(dom.filePreview.getByTestId('chat-file-preview-text').locator('.view-lines')).toContainText('UTIL_MARKER', { timeout: TURN_TIMEOUT });
    await chat.window.keyboard.press('Escape');
    await expect(dom.filePreview).toHaveCount(0);
  });

  // Last: Open in Files leaves the chat for the Files view.
  test('`:line:col` opens the preview there, and Open in Files at that place', async () => {
    const dom = chatDom(chat.window);
    const chip = dom.fileChip(p.app);
    await expect(chip).toHaveAttribute('data-chat-file', 'text', { timeout: TURN_TIMEOUT });
    await expect(chip).toHaveAttribute('data-chat-line', '7');
    await expect(chip).toHaveAttribute('data-chat-col', '3');
    await chip.click();
    await expect(dom.filePreview).toContainText(`${p.app}:7:3`);
    const text = dom.filePreview.getByTestId('chat-file-preview-text');
    await expect(text.locator('.view-lines')).toContainText('totalLine7', { timeout: TURN_TIMEOUT });
    await expect(text.locator('.line-numbers.active-line-number')).toHaveText('7');

    await dom.filePreview.getByRole('button', { name: 'Open in Files' }).click();
    await expect(dom.filePreview).toHaveCount(0);
    await expect(chat.window.getByTestId('files-active-path')).toContainText('app.ts', { timeout: TURN_TIMEOUT });
    await expect(chat.window.getByTestId('files-cursor')).toHaveText('Ln 7, Col 3', { timeout: TURN_TIMEOUT });

    await chat.expectScriptComplete();
  });
});

test('codex: a path in command output becomes a chip that previews the file', async () => {
  let filePath = '';
  session = await openRichChat({
    cli: 'codex',
    projectFiles: { [path.join('src', 'util.ts')]: 'export const CODEX_MARKER = 1;\n' },
    script: ({ projectDir }) => {
      filePath = path.join(projectDir, 'src', 'util.ts');
      return {
        description: 'a command whose output names a project file',
        turns: [{ steps: [{ type: 'command', command: 'ls src', output: `${filePath}\n` }, { type: 'text', text: 'That is the only file.' }] }],
      };
    },
  });
  const dom = chatDom(session.window);
  await session.send('What is in src?');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });

  const card = session.window.getByTestId('chat-command-card');
  await expect(card).toHaveAttribute('data-status', 'completed');
  // A finished command is collapsed; Codex names it `/bin/sh -lc '…'`.
  await card.getByRole('button', { name: /^Expand command / }).click();
  const chip = card.locator('pre').locator('[data-chat-file="text"]');
  await expect(chip).toHaveAttribute('data-chat-path', filePath, { timeout: TURN_TIMEOUT });
  await chip.click();
  await expect(dom.filePreview.getByTestId('chat-file-preview-text').locator('.view-lines')).toContainText('CODEX_MARKER', { timeout: TURN_TIMEOUT });
  await session.window.keyboard.press('Escape');
  await expect(dom.filePreview).toHaveCount(0);

  await session.expectScriptComplete();
});
