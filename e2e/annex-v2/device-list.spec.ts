/**
 * Annex Network stage 1 (#3057): one device list, instant removal, clear errors.
 *
 * Two desktops pair for real: the controller pastes the satellite's pairing
 * link (pointed at loopback). Both then show the other in the one device list.
 * Removing the controller on the satellite cuts its connection at once, and the
 * controller's list says what happened and what to do.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import { enableAnnexViaPreload, getAnnexStatus } from './helpers';

interface Device {
  fingerprint: string;
  alias: string;
  role: 'controller' | 'satellite' | null;
  state: 'connected' | 'connecting' | 'offline' | 'needs-pairing';
  problem: { code: string; message: string; action: string } | null;
}

let handles: DualInstanceHandles;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();
  await enableAnnexViaPreload(handles.satellite.window);
  await enableAnnexViaPreload(handles.controller.window);
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

function listDevices(page: Page): Promise<Device[]> {
  return page.evaluate(() => (window as any).clubhouse.annex.listDevices());
}

async function deviceOn(page: Page, fingerprint: string): Promise<Device | undefined> {
  return (await listDevices(page)).find((d) => d.fingerprint.toLowerCase() === fingerprint.toLowerCase());
}

/** The satellite's pairing link, pointed at loopback so it works on any runner. */
async function loopbackPairingLink(page: Page): Promise<string> {
  let link: string | undefined;
  await expect.poll(async () => {
    link = (await getAnnexStatus(page) as unknown as { pairingUrl?: string }).pairingUrl;
    return !!link;
  }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  return url.toString();
}

test('two desktops pair, list each other, and removal cuts the connection with a clear reason', async () => {
  const { satellite, controller } = handles;
  const satStatus = await getAnnexStatus(satellite.window);
  const ctrlStatus = await getAnnexStatus(controller.window);

  // Pair from the controller with the satellite's link.
  const link = await loopbackPairingLink(satellite.window);
  const result = await controller.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), link);
  expect(result).toMatchObject({ success: true });

  // The controller lists the satellite as a device it controls, connected.
  await expect.poll(async () => (await deviceOn(controller.window, satStatus.fingerprint))?.state, { timeout: 30_000 }).toBe('connected');
  expect(await deviceOn(controller.window, satStatus.fingerprint)).toMatchObject({ role: 'satellite', problem: null });

  // The satellite lists the controller as a device that controls it, connected.
  await expect.poll(async () => (await deviceOn(satellite.window, ctrlStatus.fingerprint))?.state, { timeout: 30_000 }).toBe('connected');
  expect(await deviceOn(satellite.window, ctrlStatus.fingerprint)).toMatchObject({ role: 'controller' });

  // Remove the controller on the satellite: gone from its list at once.
  const removed = await satellite.window.evaluate((fp) => (window as any).clubhouse.annex.removeDevice(fp), ctrlStatus.fingerprint);
  expect(removed).toBe(true);
  expect(await deviceOn(satellite.window, ctrlStatus.fingerprint)).toBeUndefined();

  // The controller's connection is cut, and it says what happened and what to do.
  await expect.poll(async () => (await deviceOn(controller.window, satStatus.fingerprint))?.state, { timeout: 30_000 }).toBe('needs-pairing');
  const cut = await deviceOn(controller.window, satStatus.fingerprint);
  expect(cut?.problem?.code).toBe('removed-there');
  expect(cut?.problem?.message).toMatch(/no longer paired/);
  expect(cut?.problem?.action).toBe('Pair again to connect.');

  // Forgetting it on the controller takes it off that list too.
  expect(await controller.window.evaluate((fp) => (window as any).clubhouse.annex.removeDevice(fp), satStatus.fingerprint)).toBe(true);
  expect(await deviceOn(controller.window, satStatus.fingerprint)).toBeUndefined();
});
