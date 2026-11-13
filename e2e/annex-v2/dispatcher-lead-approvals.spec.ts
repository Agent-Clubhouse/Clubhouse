/**
 * Approvals from other computers in the lead's chat (#3354), over two real
 * desktops and fake CLIs. CI only. The follower's Dispatcher asks for a real
 * permission through the MCP bridge (e2e/mcp-agent.ts); no tokens are spent.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { enableAnnexViaPreload } from './helpers';
import { askFirstWaiting, connectMcp, raiseAskFirst } from '../mcp-agent';

const apps: LaunchedApp[] = [];
const profiles: DisposableProfile[] = [];
let fakes: FakeClis | undefined;
let scratch: string | undefined;
test.setTimeout(180_000);
test.afterEach(async () => {
  // Keep profiles and fixtures if either desktop cannot be closed.
  const closed = await Promise.allSettled(apps.map((app) => app.electronApp.close()));
  for (const result of closed) if (result.status === 'rejected') throw result.reason;
  apps.length = 0;
  for (const profile of profiles) profile.dispose();
  profiles.length = 0;
  await fakes?.cleanup(); fakes = undefined;
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  scratch = undefined;
});
async function desktop(name: string, profile?: DisposableProfile) {
  const fresh = !profile;
  if (!profile) { profile = createDisposableProfile({ label: name }); profiles.push(profile); }
  const app = await launchApp({
    label: name, profile, args: ['--disable-gpu'], env: fakes!.env,
    userDataFiles: fresh ? {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
      'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName: name, alias: name, icon: 'computer', color: 'indigo', autoReconnect: true },
    } : {},
  });
  apps.push(app);
  await app.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
  return app;
}
const machine = async (page: Page) => (await page.evaluate(() => window.clubhouse.annex.getStatus())).fingerprint!.toLowerCase();
const lead = (page: Page) => page.evaluate(() => window.clubhouse.dispatcher.getLead());
const startedAs = async () => (await fakes!.report('claude').catch(() => undefined))?.env.CLUBHOUSE_AGENT_ID;

/** Wakes a computer's Dispatcher chat from its view, as a person does; resolves with the chat's id. */
async function wakeDispatcherChat(page: Page): Promise<string> {
  const state = await page.evaluate(() => window.clubhouse.dispatcher.get());
  await page.locator('[data-testid="dispatcher-row"] [role="treeitem"]').click();
  await expect(page.locator('[data-testid="dispatcher-view"]')).toHaveAttribute('data-agent-id', state.chatAgentId!);
  await page.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(startedAs, { timeout: 20_000 }).toBe(state.chatAgentId);
  return state.chatAgentId!;
}

test('a follower’s Ask-first request shows in the lead’s chat with its computer, and the first answer wins', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dispatcher-lead-approvals-e2e-'));
  const fixture = path.join(scratch, 'quiet.jsonl');
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  await fs.promises.writeFile(fixture, `${lines.join('\n')}\n`);
  fakes = await installFakeClis({ claude: fixture });
  const here = await desktop('Desk'); const there = await desktop('Laptop');
  await enableAnnexViaPreload(there.window); await enableAnnexViaPreload(here.window);
  let url = '';
  await expect.poll(async () => { url = (await there.window.evaluate(() => window.clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!url; }).toBe(true);
  const pairing = new URL(url); pairing.searchParams.delete('host'); pairing.searchParams.append('host', '127.0.0.1');
  expect(await here.window.evaluate((link) => window.clubhouse.annexClient.pairWithLink(link), pairing.toString())).toMatchObject({ success: true });
  const desk = await machine(here.window);

  // Laptop's Dispatcher at work: its chat hands a request to its controller, which the test then acts as.
  await wakeDispatcherChat(there.window);
  const laptopChat = await connectMcp((await fakes!.report('claude')).env);
  const controllerId = (await there.window.evaluate(() => window.clubhouse.dispatcher.get())).agentId;
  expect((await laptopChat.callText('start_work', { request: 'tidy the app settings' })).isError).toBe(false);
  await expect.poll(startedAs, { timeout: 20_000 }).toBe(controllerId);
  const laptopController = await connectMcp((await fakes!.report('claude')).env);

  // Desk leads, and its chat is open.
  await expect.poll(async () => (await lead(here.window)).canChoose, { timeout: 30_000 }).toBe(true);
  await here.window.evaluate((id) => window.clubhouse.dispatcher.setLead(id), desk);
  await expect.poll(async () => (await lead(there.window)).following, { timeout: 30_000 }).toBe(true);
  await wakeDispatcherChat(here.window);

  // An Ask-first request on Laptop shows in Desk's chat and Needs you, Laptop first; Decline on Desk applies on Laptop.
  const first = await raiseAskFirst(there.window, laptopController, { action: 'settings.app.write', target: 'app', reason: 'E2E: change an app setting.' });
  const row = here.window.getByTestId('dispatcher-remote-approval');
  await expect(row).toContainText('Laptop:', { timeout: 30_000 });
  await expect(here.window.locator('[data-testid^="needs-you-row-"]').filter({ hasText: 'Laptop:' })).toHaveCount(1);
  await here.window.getByTestId('dispatcher-remote-approval-decline').click();
  await expect.poll(() => askFirstWaiting(there.window, first), { timeout: 30_000 }).toBe(false);
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  // Answered on Laptop first: it leaves Desk's chat.
  const second = await raiseAskFirst(there.window, laptopController, { action: 'settings.app.write', target: 'app', reason: 'E2E: ask again.' });
  await expect(row).toContainText('Laptop:', { timeout: 30_000 });
  await there.window.evaluate((id) => window.clubhouse.agent.answerGrantRequest(id, false), second);
  await expect(row).toHaveCount(0, { timeout: 30_000 });
});
