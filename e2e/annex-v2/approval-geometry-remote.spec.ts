/**
 * Approvals from other computers in the lead's chat (#3606, S5): three Ask-first
 * requests from Laptop, of different lengths, answered from the head one after
 * another on Desk, at each window size. Two real desktops and fake CLIs, CI
 * only, no tokens (the setup is dispatcher-lead-approvals.spec.ts's). A probe:
 * see e2e/approval-geometry.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { GeometryLog, originalSize, setWindowSize, WINDOW_SIZES } from '../approval-geometry';
import { enableAnnexViaPreload } from './helpers';
import { connectMcp, raiseAskFirst } from '../mcp-agent';

const apps: LaunchedApp[] = [];
const profiles: DisposableProfile[] = [];
let fakes: FakeClis | undefined;
let scratch: string | undefined;
test.setTimeout(300_000);
test.afterEach(async () => {
  const closed = await Promise.allSettled(apps.map((app) => app.electronApp.close()));
  for (const result of closed) if (result.status === 'rejected') throw result.reason;
  apps.length = 0;
  for (const profile of profiles) profile.dispose();
  profiles.length = 0;
  await fakes?.cleanup(); fakes = undefined;
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  scratch = undefined;
});
async function desktop(name: string) {
  const profile = createDisposableProfile({ label: name });
  profiles.push(profile);
  const app = await launchApp({
    label: name, profile, args: ['--disable-gpu'], env: fakes!.env,
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
      'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName: name, alias: name, icon: 'computer', color: 'indigo', autoReconnect: true },
    },
  });
  apps.push(app);
  await app.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
  return app;
}
const machine = async (page: Page) => (await page.evaluate(() => window.clubhouse.annex.getStatus())).fingerprint!.toLowerCase();
const lead = (page: Page) => page.evaluate(() => window.clubhouse.dispatcher.getLead());
const startedAs = async (): Promise<string | null | undefined> => (await fakes!.report('claude').catch((): undefined => undefined))?.env.CLUBHOUSE_AGENT_ID;

/** Wakes a computer's Dispatcher chat from its view, as a person does; resolves with the chat's id. */
async function wakeDispatcherChat(page: Page): Promise<string> {
  const state = await page.evaluate(() => window.clubhouse.dispatcher.get());
  await page.locator('[data-testid="dispatcher-row"] [role="treeitem"]').click();
  await expect(page.locator('[data-testid="dispatcher-view"]')).toHaveAttribute('data-agent-id', state.chatAgentId!);
  await page.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(startedAs, { timeout: 20_000 }).toBe(state.chatAgentId);
  return state.chatAgentId!;
}

const SENTENCE = 'because the task I was given touches this and the refusal named it, so I need the permission before I can carry on';

/** Short, medium and long reasons. One action on three targets: each is its own request. */
const REQUESTS = [
  { action: 'settings.app.write', target: 'app', reason: 'To change one setting.' },
  { action: 'settings.app.write', target: 'any', reason: `I need to change settings ${SENTENCE}.` },
  { action: 'settings.app.write', target: 'own_project', reason: Array.from({ length: 4 }, () => `I need to change this project's settings ${SENTENCE}.`).join(' ').slice(0, 480) },
];

test('the lead’s remote approvals keep Allow in one place across three requests at three sizes', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'approval-geometry-remote-e2e-'));
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

  const log = new GeometryLog('remote-approvals');
  try {
    const rows = here.window.getByTestId('dispatcher-remote-approval');
    const original = await originalSize(here.window);
    for (const size of WINDOW_SIZES) {
      await setWindowSize(here.electronApp, here.window, size, original);
      for (const request of REQUESTS) await raiseAskFirst(there.window, laptopController, request);
      await expect(rows).toHaveCount(REQUESTS.length, { timeout: 30_000 });
      for (const [i] of REQUESTS.entries()) {
        // The head row's first answer button (Allow), as the queue stands with i requests already answered.
        const allow = rows.first().locator('[data-testid^="dispatcher-remote-approval-allow"]').first();
        const notes = await rows.first().evaluate((row) => {
          const r = row.getBoundingClientRect();
          const dock = row.closest('[data-testid="chat-dock"]')?.getBoundingClientRect();
          return { rowTop: Math.round(r.top), rowHeight: Math.round(r.height), dockTop: dock ? Math.round(dock.top) : -1, rows: row.parentElement?.children.length ?? 0 };
        });
        await log.record(here.window, size, i + 1, allow, notes);
        await rows.first().getByTestId('dispatcher-remote-approval-decline').click();
        // Declined on Desk, applied on Laptop, and gone from Desk with Laptop's next snapshot.
        await expect(rows).toHaveCount(REQUESTS.length - 1 - i, { timeout: 30_000 });
      }
    }
  } catch (err) {
    console.log(`\n[approval-geometry] ${log.table()}\n`);
    throw err;
  }
  await log.assertStable();
});
