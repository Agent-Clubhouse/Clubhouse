/**
 * Annex Network stage 2 (#3058): a satellite reachable only by a typed host
 * connects, and connects again after the controller restarts.
 *
 * The satellite listens on loopback only and doesn't advertise over mDNS, so
 * discovery can never find it: the controller reaches it by address alone.
 * After pairing, the controller's remembered addresses are dropped and replaced
 * with a typed host while it's closed. On relaunch it must connect from that.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';
import { assertRunLayout } from '../smoke-helpers';
import { enableAnnexViaPreload } from './helpers';

interface Device {
  fingerprint: string;
  role: string | null;
  state: string;
  address?: string;
  typedHost?: string;
}

let satellite: LaunchedApp | undefined;
let controller: LaunchedApp | undefined;
let controllerProfile: DisposableProfile;

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try { await app.electronApp.close(); } catch { /* already gone */ }
  untrackOpenApp(app.electronApp);
}

test.afterAll(async () => {
  await close(controller);
  await close(satellite);
  satellite?.profile.dispose();
  controllerProfile?.dispose();
});

function status(page: Page): Promise<{ fingerprint: string; port: number; pairingUrl?: string }> {
  return page.evaluate(() => (window as any).clubhouse.annex.getStatus());
}

async function deviceOn(page: Page, fingerprint: string): Promise<Device | undefined> {
  const devices: Device[] = await page.evaluate(() => (window as any).clubhouse.annex.listDevices());
  return devices.find((d) => d.fingerprint.toLowerCase() === fingerprint.toLowerCase());
}

test('a satellite reachable only by a typed host connects, and again after the controller restarts', async () => {
  satellite = await launchApp({
    label: 'satellite',
    args: ['--disable-gpu'],
    env: { CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1' },
  });
  await assertRunLayout(satellite.window);
  controllerProfile = createDisposableProfile({ label: 'controller' });
  controller = await launchApp({ label: 'controller', args: ['--disable-gpu'], profile: controllerProfile });
  await assertRunLayout(controller.window);

  await enableAnnexViaPreload(satellite.window);
  await enableAnnexViaPreload(controller.window);
  // One-to-one (Annex Network off on the controller): this spec is about reaching a satellite.
  await controller.window.evaluate(async () => {
    const settings = await (window as any).clubhouse.annex.getSettings();
    await (window as any).clubhouse.annex.saveSettings({ ...settings, networkEnabled: false });
  });

  let link: string | undefined;
  await expect.poll(async () => { link = (await status(satellite!.window)).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  // Loopback only: the link names just 127.0.0.1.
  expect(new URL(link!).searchParams.getAll('host')).toEqual(['127.0.0.1']);
  const sat = await status(satellite.window);

  expect(await controller.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), link!)).toMatchObject({ success: true });
  await expect.poll(async () => (await deviceOn(controller!.window, sat.fingerprint))?.state, { timeout: 30_000 }).toBe('connected');
  expect((await deviceOn(controller.window, sat.fingerprint))?.address).toBe(`127.0.0.1:${sat.port}`);

  // Close the controller and leave it only a typed host to go on.
  await close(controller);
  controller = undefined;
  const peersFile = path.join(controllerProfile.userDataDir, 'annex-peers.json');
  const peers = JSON.parse(await fs.promises.readFile(peersFile, 'utf8')) as Array<Record<string, unknown>>;
  const entry = peers.find((p) => String(p.fingerprint).toLowerCase() === sat.fingerprint.toLowerCase());
  expect(entry).toMatchObject({ role: 'satellite', knownHosts: ['127.0.0.1'], mainPort: sat.port });
  delete entry!.knownHosts;
  entry!.typedHost = '127.0.0.1';
  await fs.promises.writeFile(peersFile, JSON.stringify(peers, null, 2));

  // Relaunch on the same profile: it connects from the typed host alone, with no discovery and no button.
  controller = await launchApp({ label: 'controller', args: ['--disable-gpu'], profile: controllerProfile });
  await assertRunLayout(controller.window);
  await expect.poll(async () => (await deviceOn(controller!.window, sat.fingerprint))?.state, { timeout: 60_000 }).toBe('connected');
  expect(await deviceOn(controller.window, sat.fingerprint)).toMatchObject({ typedHost: '127.0.0.1', address: `127.0.0.1:${sat.port}` });
});
