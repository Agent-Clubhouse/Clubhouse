/**
 * Chat across desktops (#2390): a controller reads and drives a chat agent that
 * runs on another desktop, through that desktop's pinned phone routes.
 *
 * The satellite runs a durable agent in chat over the fake Claude CLI (a
 * recorded fixture: no model is called). A second desktop pairs with it, reads
 * the agent's chat page, and sends both of the fixture's turns; the satellite
 * shows them finish, and the fake replays its whole fixture.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { untrackOpenApp } from '../e2e-cleanup';
import { addProject } from '../smoke-helpers';
import { enableAnnexViaPreload } from './helpers';

let fakes: FakeClis | undefined;
let projectDir: string | undefined;
let satellite: LaunchedApp | undefined;
let controller: LaunchedApp | undefined;

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try { await app.electronApp.close(); } catch { /* already gone */ }
  untrackOpenApp(app.electronApp);
}

test.afterAll(async () => {
  await close(controller);
  await close(satellite);
  await fakes?.cleanup();
  if (projectDir) await fs.promises.rm(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a controller reads and drives a chat agent on another desktop', async () => {
  fakes = await installFakeClis({ claude: 'multi-turn' });
  projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-across-'));
  satellite = await launchApp({
    label: 'satellite',
    args: ['--disable-gpu'],
    // The classic layout's agent list and New Agent dialog, as the chat E2E drives them.
    experimental: { newChrome: false },
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
    },
    env: fakes.env,
  });
  controller = await launchApp({ label: 'controller', args: ['--disable-gpu'] });
  const sat = satellite.window;

  // A durable chat agent on the satellite.
  await addProject(satellite.electronApp, sat, projectDir);
  const name = `remote-chat-${Date.now()}`;
  await sat.locator('button:has-text("+ Agent")').first().click();
  await expect(sat.locator('h2:has-text("New Agent")')).toBeVisible({ timeout: 5_000 });
  await sat.locator('input[type="text"]').first().fill(name);
  await sat.locator('label:has-text("Runs on") select').selectOption('claude-code');
  await sat.locator('button:has-text("Create Agent")').click();
  const item = sat.locator(`[data-agent-name="${name}"][data-testid^="agent-item-durable_"]`);
  await expect(item).toBeVisible({ timeout: 20_000 });
  const agentId = (await item.getAttribute('data-testid'))!.replace(/^agent-item-/, '');
  await item.click();
  const chat = sat.locator('[data-testid="chat-view"]');
  await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });

  // The controller pairs with the satellite.
  await enableAnnexViaPreload(sat);
  await enableAnnexViaPreload(controller.window);
  let link: string | undefined;
  await expect.poll(async () => { link = (await sat.evaluate(() => (window as any).clubhouse.annex.getStatus())).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  expect(await controller.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), url.toString())).toMatchObject({ success: true });
  const satFp = ((await sat.evaluate(() => (window as any).clubhouse.annex.getStatus())).fingerprint as string).toLowerCase();
  await expect.poll(async () => {
    const sats: Array<{ fingerprint: string; state: string }> = await controller!.window.evaluate(() => (window as any).clubhouse.annexClient.getSatellites());
    return sats.find((s) => s.fingerprint.toLowerCase() === satFp)?.state;
  }, { timeout: 30_000 }).toBe('connected');

  // The controller reads the agent's chat from the satellite.
  const page = await controller.window.evaluate(([fp, id]) => (window as any).clubhouse.annexClient.chatPage(fp, id, { limit: 100 }), [satFp, agentId] as const);
  expect(page).toMatchObject({ agentId, state: 'idle' });
  const sessionId = page.sessionId as string;
  expect(sessionId).toBeTruthy();

  // ...and sends both turns; the satellite shows each finish.
  const footers = sat.locator('[data-testid="chat-turn-footer"]');
  for (const [i, text] of ['Reply with the word one.', 'Reply with the word two.'].entries()) {
    const receipt = await controller.window.evaluate(([fp, id, sid, t]) => (window as any).clubhouse.annexClient.chatCommand(fp, { type: 'chat.send', agentId: id, sessionId: sid, text: t }), [satFp, agentId, sessionId, text] as const);
    expect(receipt).toMatchObject({ status: 'completed' });
    await expect(footers).toHaveCount(i + 1, { timeout: 20_000 });
  }
  await expect(chat).toHaveAttribute('data-state', 'idle');

  // The controller sees the finished conversation in its page too.
  const after = await controller.window.evaluate(([fp, id]) => (window as any).clubhouse.annexClient.chatPage(fp, id, { limit: 200 }), [satFp, agentId] as const);
  expect((after.events as Array<{ type: string }>).filter((e) => e.type === 'turn_ended').length).toBeGreaterThanOrEqual(2);

  await expect.poll(async () => {
    const report = await fakes!.report('claude').catch((): undefined => undefined);
    return report && { mismatch: report.mismatch, complete: report.complete };
  }, { timeout: 20_000 }).toEqual({ mismatch: null, complete: true });
});
