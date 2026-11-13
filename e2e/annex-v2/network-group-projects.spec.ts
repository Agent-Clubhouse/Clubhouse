/**
 * Network group projects (#3363), two desktops over the real Annex Network.
 *
 * Desk hosts a group project shared with the network. Studio, the other
 * computer, shows a copy named by its host, posts to it, and Desk has the post.
 * Then Desk quits: Studio still reads the copy, and its post waits for Desk.
 * Desk starts again with the same profile and the waiting post is applied.
 * Fake CLIs only: no agent or model is started.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';
import { assertRunLayout } from '../smoke-helpers';
import { enableAnnexViaPreload } from './helpers';

let fakesDesk: FakeClis | undefined;
let fakesStudio: FakeClis | undefined;
let scratch: string | undefined;
let desk: LaunchedApp | undefined;
let studio: LaunchedApp | undefined;
const profiles: DisposableProfile[] = [];

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  untrackOpenApp(app.electronApp);
  await app.electronApp.close().catch((): undefined => undefined);
}

test.afterAll(async () => {
  await close(desk);
  await close(studio);
  for (const profile of profiles) profile.dispose();
  await fakesDesk?.cleanup();
  await fakesStudio?.cleanup();
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true });
});

async function quietFixture(dir: string): Promise<string> {
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  const file = path.join(dir, 'quiet.jsonl');
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** A fresh desktop is seeded; a relaunch (no `deviceName`) keeps what it saved, Annex and its pairing included. */
async function launchDesktop(profile: DisposableProfile, label: string, fakes: FakeClis, deviceName?: string): Promise<LaunchedApp> {
  const app = await launchApp({
    profile,
    label,
    args: ['--disable-gpu'],
    ...(deviceName && {
      userDataFiles: {
        'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
        'annex-settings.json': { enableServer: false, enableClient: false, deviceName, alias: deviceName, icon: 'computer', color: 'indigo', autoReconnect: true },
      },
    }),
    env: fakes.env,
  });
  await assertRunLayout(app.window);
  return app;
}

const fingerprintOf = async (w: Page): Promise<string> =>
  ((await w.evaluate(() => (window as any).clubhouse.annex.getStatus())).fingerprint as string).toLowerCase();

async function connectedTo(w: Page, fingerprint: string): Promise<string | undefined> {
  const satellites: Array<{ fingerprint: string; state: string }> = await w.evaluate(() => (window as any).clubhouse.annexClient.getSatellites());
  return satellites.find((s) => s.fingerprint.toLowerCase() === fingerprint)?.state;
}

interface ListedGroupProject {
  id: string;
  hostName?: string;
  network?: { role: string; state: string; waitingWrites: number };
}

const listOn = (w: Page): Promise<ListedGroupProject[]> => w.evaluate(() => (window as any).clubhouse.groupProject.list());
const bodiesOn = async (w: Page, id: string): Promise<string[]> =>
  ((await w.evaluate(([gp]) => (window as any).clubhouse.groupProject.getTopicMessages(gp, 'work'), [id] as const)) as Array<{ body: string }>).map((m) => m.body);

test('a network group project works from the other computer, with its host away and back', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'network-group-projects-'));
  const fixture = await quietFixture(scratch);
  fakesDesk = await installFakeClis({ claude: fixture });
  fakesStudio = await installFakeClis({ claude: fixture });
  const deskProfile = createDisposableProfile({ label: 'gp-desk' });
  const studioProfile = createDisposableProfile({ label: 'gp-studio' });
  profiles.push(deskProfile, studioProfile);
  desk = await launchDesktop(deskProfile, 'gp-desk', fakesDesk, 'Desk');
  studio = await launchDesktop(studioProfile, 'gp-studio', fakesStudio, 'Studio');

  // The two computers join one network.
  await enableAnnexViaPreload(studio.window);
  await enableAnnexViaPreload(desk.window);
  let link = '';
  await expect.poll(async () => { link = (await studio!.window.evaluate(() => (window as any).clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!link; }, { timeout: 15_000 }).toBe(true);
  const pairing = new URL(link);
  pairing.searchParams.delete('host');
  pairing.searchParams.append('host', '127.0.0.1');
  expect(await desk.window.evaluate((value) => (window as any).clubhouse.annexClient.pairWithLink(value), pairing.toString())).toMatchObject({ success: true });
  const deskFp = await fingerprintOf(desk.window);
  const studioFp = await fingerprintOf(studio.window);
  await expect.poll(() => connectedTo(desk!.window, studioFp), { timeout: 30_000 }).toBe('connected');
  await expect.poll(() => connectedTo(studio!.window, deskFp), { timeout: 30_000 }).toBe('connected');

  // Desk shares a group project with the network.
  await expect.poll(async () => (await desk!.window.evaluate(() => (window as any).clubhouse.groupProject.scopeOptions())).network.available, { timeout: 15_000 }).toBe(true);
  const created: { id: string; host: { machine: string } } = await desk.window.evaluate(() => (window as any).clubhouse.groupProject.create('Launch', { scope: { level: 'app', reach: 'network' } }));
  expect(created.host.machine).toBe(deskFp);
  const id = created.id;

  // Studio shows a copy, named by its host, never by fingerprint.
  await expect.poll(async () => (await listOn(studio!.window)).find((p) => p.id === id), { timeout: 30_000 })
    .toMatchObject({ hostName: 'Desk', network: { role: 'replica', state: 'online', waitingWrites: 0 } });

  // A post on Studio reaches the host, and both show it.
  await studio.window.evaluate(([gp]) => (window as any).clubhouse.groupProject.postBulletinMessage(gp, 'work', 'from the studio'), [id] as const);
  await expect.poll(() => bodiesOn(desk!.window, id), { timeout: 30_000 }).toEqual(['from the studio']);
  await expect.poll(() => bodiesOn(studio!.window, id), { timeout: 30_000 }).toEqual(['from the studio']);

  // Desk quits: Studio reads its copy, and its post waits for Desk.
  await close(desk);
  desk = undefined;
  await expect.poll(async () => (await listOn(studio!.window)).find((p) => p.id === id)?.network?.state, { timeout: 60_000 }).toBe('cached');
  const queued: { pending?: { waitingFor: string } } = await studio.window.evaluate(([gp]) => (window as any).clubhouse.groupProject.postBulletinMessage(gp, 'work', 'while you were away'), [id] as const);
  expect(queued.pending).toEqual({ waitingFor: 'Desk' });
  expect(await bodiesOn(studio.window, id)).toEqual(['from the studio']);
  await expect.poll(async () => (await listOn(studio!.window)).find((p) => p.id === id)?.network?.waitingWrites, { timeout: 15_000 }).toBe(1);

  // Desk is back: the waiting post is applied, in order, and Studio's copy follows.
  desk = await launchDesktop(deskProfile, 'gp-desk-again', fakesDesk);
  expect(await fingerprintOf(desk.window)).toBe(deskFp);
  await expect.poll(() => bodiesOn(desk!.window, id), { timeout: 60_000 }).toEqual(['from the studio', 'while you were away']);
  await expect.poll(() => bodiesOn(studio!.window, id), { timeout: 60_000 }).toEqual(['from the studio', 'while you were away']);
  await expect.poll(async () => (await listOn(studio!.window)).find((p) => p.id === id)?.network, { timeout: 30_000 })
    .toMatchObject({ state: 'online', waitingWrites: 0 });
});
