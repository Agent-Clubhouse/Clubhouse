import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { GeometryLog, originalSize, setWindowSize, WINDOW_SIZES } from '../approval-geometry';
import { connectMcp, raiseAskFirst } from '../mcp-agent';
import { openRichChat } from './harness';

/**
 * The grant review dialog (#3606, S4): an agent's three waiting Clubhouse
 * permission requests, of different lengths, answered from the head one after
 * another, at each window size. Agents ask through the real MCP bridge with no
 * tokens; the fake CLI only has to be running. A probe: see e2e/approval-geometry.ts.
 */

const SENTENCE = 'because the task I was given touches this and the refusal named it, so I need the permission before I can carry on';

/** Short, medium and long reasons. One action on three targets: each is its own request, and an ordinary agent holds none of them. */
const REQUESTS = [
  { action: 'settings.app.write', target: 'app', reason: 'To change one setting.' },
  { action: 'settings.app.write', target: 'any', reason: `I need to change settings ${SENTENCE}.` },
  { action: 'settings.app.write', target: 'own_project', reason: Array.from({ length: 4 }, () => `I need to change this project's settings ${SENTENCE}.`).join(' ').slice(0, 480) },
];

/** An opened app with no turn in it: the fake only has to be running for its agent to hold the MCP bridge. */
async function writeQuietFixture(dir: string): Promise<string> {
  const fixture = path.join(dir, 'quiet.jsonl');
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  await fs.promises.writeFile(fixture, `${lines.join('\n')}\n`);
  return fixture;
}

async function openReview(page: Page, agentId: string) {
  await page.locator(`[data-testid="needs-you-row-${agentId}"]`).click();
  const dialog = page.locator('[data-testid="grant-request-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.setTimeout(240_000);
test('the grant review dialog keeps Allow in one place across three requests at three sizes', async () => {
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'approval-geometry-grants-'));
  const log = new GeometryLog('grant-dialog');
  const s = await openRichChat({ cli: 'claude', script: await writeQuietFixture(scratch) });
  try {
    const { window } = s;
    const mcp = await connectMcp((await s.fakes.report('claude')).env);
    const original = await originalSize(window);
    for (const size of WINDOW_SIZES) {
      // Open it from the default layout, where Needs you is on screen, then take the window to the size under test.
      await setWindowSize(s.electronApp, window, WINDOW_SIZES[0], original);
      for (const request of REQUESTS) await raiseAskFirst(window, mcp, request);
      const dialog = await openReview(window, s.agentId);
      await setWindowSize(s.electronApp, window, size, original);
      const allow = dialog.locator('[data-testid="grant-request-allow"]');
      await expect(allow).toHaveCount(REQUESTS.length);
      for (const [i] of REQUESTS.entries()) {
        // The head request's Allow, as the list stands with i requests already answered.
        const notes = await dialog.evaluate((panel) => {
          const r = panel.getBoundingClientRect();
          const scroller = [...panel.querySelectorAll<HTMLElement>('*')].find((el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible');
          return { panelTop: Math.round(r.top), panelHeight: Math.round(r.height), panelScrolls: !!scroller, rows: panel.querySelectorAll('[data-testid="grant-request-list"] > li').length };
        });
        await log.record(window, size, i + 1, allow.first(), notes);
        await dialog.locator('[data-testid="grant-request-decline"]').first().click();
        if (i < REQUESTS.length - 1) await expect(allow).toHaveCount(REQUESTS.length - 1 - i);
      }
      // The last answer closes the dialog.
      await expect(dialog).toBeHidden();
    }
  } catch (err) {
    console.log(`\n[approval-geometry] ${log.table()}\n`);
    throw err;
  } finally {
    await s.close();
    await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  await log.assertStable();
});
