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
 * another, at each window size. The dialog keeps its size and place and its
 * answers stay in its footer. Agents ask through the real MCP bridge with no
 * tokens; the fake CLI only has to be running. See e2e/approval-geometry.ts.
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
test('the grant review dialog keeps Allow and Decline in one place across three requests at three sizes', async () => {
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
      // The dialog shows the oldest request; the rest wait behind it.
      const allow = dialog.locator('[data-testid="grant-request-allow"]');
      const decline = dialog.locator('[data-testid="grant-request-decline"]');
      for (const [i, request] of REQUESTS.entries()) {
        await expect(dialog).toContainText(request.reason.slice(0, 40));
        await expect(allow).toHaveCount(1);
        const notes = await dialog.evaluate((panel) => {
          const r = panel.getBoundingClientRect();
          return { panelTop: Math.round(r.top), panelHeight: Math.round(r.height) };
        });
        await log.record(window, size, i + 1, { allow, decline }, notes);
        await decline.click();
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
  await log.assertAnchored();
});
