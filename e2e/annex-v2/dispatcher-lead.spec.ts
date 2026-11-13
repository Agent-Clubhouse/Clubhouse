/** The network-wide lead Dispatcher (#3351) over two real desktops and fake CLIs. CI only. */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { enableAnnexViaPreload } from './helpers';

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

test('a lead chosen on one computer reaches the other, catches up after a restart, and clears when its computer is removed', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dispatcher-lead-e2e-'));
  const fixture = path.join(scratch, 'quiet.jsonl');
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  await fs.promises.writeFile(fixture, `${lines.join('\n')}\n`);
  fakes = await installFakeClis({ claude: fixture });
  const here = await desktop('Desk'); let there = await desktop('Laptop');
  await enableAnnexViaPreload(there.window); await enableAnnexViaPreload(here.window);
  let url = '';
  await expect.poll(async () => { url = (await there.window.evaluate(() => window.clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!url; }).toBe(true);
  const pairing = new URL(url); pairing.searchParams.delete('host'); pairing.searchParams.append('host', '127.0.0.1');
  expect(await here.window.evaluate((link) => window.clubhouse.annexClient.pairWithLink(link), pairing.toString())).toMatchObject({ success: true });
  const desk = await machine(here.window); const laptop = await machine(there.window);
  await expect.poll(async () => (await lead(here.window)).available, { timeout: 30_000 }).toBe(true);

  // Chosen on Desk, Laptop leads; both agree, and Desk sees Laptop has it.
  await here.window.evaluate((id) => window.clubhouse.dispatcher.setLead(id), laptop);
  await expect.poll(async () => (await lead(there.window)).role, { timeout: 30_000 }).toBe('lead');
  expect((await lead(here.window)).role).toBe('follower');
  await expect.poll(async () => (await lead(here.window)).waitingOn, { timeout: 30_000 }).toEqual([]);

  // Laptop is off while Desk changes it; it catches up when it's back.
  const profile = there.profile;
  await there.electronApp.close(); apps.splice(apps.indexOf(there), 1);
  await expect.poll(async () => (await lead(here.window)).lead?.online, { timeout: 30_000 }).toBe(false);
  expect((await lead(here.window)).role).toBe('follower');
  await here.window.evaluate((id) => window.clubhouse.dispatcher.setLead(id), desk);
  there = await desktop('Laptop', profile);
  await expect.poll(async () => (await lead(there.window)).lead?.machine, { timeout: 45_000 }).toBe(desk);
  expect((await lead(there.window)).role).toBe('follower');

  // Removing the lead's computer returns the other to peers, and says which left.
  await there.window.evaluate((fingerprint) => window.clubhouse.annex.removeDevice(fingerprint), desk);
  await expect.poll(async () => (await lead(there.window)).role, { timeout: 30_000 }).toBe('peer');
});
