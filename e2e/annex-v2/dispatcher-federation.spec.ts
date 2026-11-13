/** Automatic controller links over two real desktops and fake CLIs. CI only. */
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
const identity = async (page: Page) => {
  const state = await page.evaluate(() => window.clubhouse.dispatcher.get());
  const annex = await page.evaluate(() => window.clubhouse.annex.getStatus());
  expect(state.agentId).toBeTruthy(); expect(state.chatAgentId).not.toBe(state.agentId);
  return { controller: state.agentId!, chat: state.chatAgentId!, machine: annex.fingerprint!.toLowerCase() };
};
const links = (page: Page, id: string) => page.evaluate(async (controller) => {
  const sources = await window.clubhouse.mcpBinding.getConnectionSources(controller);
  return sources.pairs.filter((p) => p.sources.some((s) => s.kind === 'dispatcher_federation'));
}, id);

test('membership creates two-way controller links, pauses offline, resumes, refuses edits and removes them', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dispatcher-federation-e2e-'));
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
  const a = await identity(here.window); const b = await identity(there.window);
  const remote = `${b.controller}@${b.machine}`;
  await expect.poll(async () => (await links(here.window, a.controller)).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(2);
  expect((await links(here.window, a.controller)).some((p) => p.targetId === remote)).toBe(true);
  expect((await links(here.window, a.controller)).some((p) => p.targetId.startsWith(b.chat))).toBe(false);
  await expect(here.window.evaluate(([id, target]) => window.clubhouse.mcpBinding.setDisabledTools(id, target, []), [a.controller, remote] as const)).rejects.toThrow('membership');
  expect(await here.window.evaluate(([id, target]) => window.clubhouse.mcpBinding.unbind(id, target), [a.controller, remote] as const)).toMatchObject({ kept: true });
  await there.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(false));
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended?.includes('Dispatcher is off')), { timeout: 30_000 }).toBe(true);
  await there.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended), { timeout: 30_000 }).toBe(false);
  const profile = there.profile;
  await there.electronApp.close(); apps.splice(apps.indexOf(there), 1);
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended?.includes('offline')), { timeout: 30_000 }).toBe(true);
  there = await desktop('Laptop', profile);
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended), { timeout: 45_000 }).toBe(false);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(2);
  await here.window.evaluate((fingerprint) => window.clubhouse.annex.removeDevice(fingerprint), b.machine);
  await expect.poll(async () => (await links(here.window, a.controller)).length).toBe(0);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(0);
});
