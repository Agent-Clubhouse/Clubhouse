/**
 * Annex Network stage 4 (#3061): join once, removed everywhere.
 *
 * Three members: desktops A and B, and a fake member F (a test identity with its
 * own server). B and A pair, and both become members. B is then closed, and F
 * joins through A alone. When B comes back it learns of F from A and connects
 * to F with no pairing of its own. Removing F on A reaches B, and A shows the
 * removal confirmed once B has it.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';
import { enableAnnexViaPreload } from './helpers';
import { startFakeMember, type FakeMember } from './fake-member';

interface Device { fingerprint: string; role: string | null; state: string; confirmation?: { kind: string; confirmedBy: string[]; waitingOn: string[] } }

let a: LaunchedApp | undefined;
let b: LaunchedApp | undefined;
let bProfile: DisposableProfile;
let fake: FakeMember | undefined;

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try { await app.electronApp.close(); } catch { /* already gone */ }
  untrackOpenApp(app.electronApp);
}

test.afterAll(async () => {
  await fake?.close();
  await close(b);
  await close(a);
  a?.profile.dispose();
  bProfile?.dispose();
});

const launch = (label: string, profile?: DisposableProfile) =>
  launchApp({ label, args: ['--disable-gpu'], experimental: { newChrome: false }, ...(profile && { profile }) });

function status(page: Page): Promise<{ fingerprint: string; port: number; pin: string; pairingUrl?: string }> {
  return page.evaluate(() => (window as any).clubhouse.annex.getStatus());
}

async function device(page: Page, fingerprint: string): Promise<Device | undefined> {
  const devices: Device[] = await page.evaluate(() => (window as any).clubhouse.annex.listDevices());
  return devices.find((d) => d.fingerprint.toLowerCase() === fingerprint.toLowerCase());
}

test('a join through one member reaches a member that was off, and a removal is confirmed everywhere', async () => {
  a = await launch('member-a');
  bProfile = createDisposableProfile({ label: 'member-b' });
  b = await launch('member-b', bProfile);
  await enableAnnexViaPreload(a.window);
  await enableAnnexViaPreload(b.window);

  // B pairs with A: with Annex Network on both, each is a member of the other.
  let link: string | undefined;
  await expect.poll(async () => { link = (await status(a!.window)).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  expect(await b.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), url.toString())).toMatchObject({ success: true });
  const aStatus = await status(a.window);
  const bStatus = await status(b.window);
  await expect.poll(async () => (await device(b!.window, aStatus.fingerprint))?.state, { timeout: 30_000 }).toBe('connected');
  expect((await device(b.window, aStatus.fingerprint))?.role).toBe('member');
  await expect.poll(async () => (await device(a!.window, bStatus.fingerprint))?.role, { timeout: 30_000 }).toBe('member');

  // B goes off. F joins through A alone.
  await close(b);
  b = undefined;
  fake = await startFakeMember();
  await fake.joinVia('127.0.0.1', aStatus.port, (await status(a.window)).pin);
  const F = fake.identity.fingerprint;
  await expect.poll(async () => (await device(a!.window, F))?.role, { timeout: 30_000 }).toBe('member');
  // A connects to F by itself, from the address in F's hello.
  await expect.poll(() => fake!.controlledBy.has(aStatus.fingerprint.toLowerCase()), { timeout: 30_000 }).toBe(true);
  // B hasn't heard yet: A shows the join waiting on it.
  await expect.poll(async () => (await device(a!.window, F))?.confirmation?.waitingOn.length ?? 0, { timeout: 15_000 }).toBe(1);

  // B comes back: it learns of F from A and connects to F, with no pairing of its own.
  b = await launch('member-b', bProfile);
  await expect.poll(async () => (await device(b!.window, F))?.role, { timeout: 60_000 }).toBe('member');
  await expect.poll(() => fake!.controlledBy.has(bStatus.fingerprint.toLowerCase()), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => fake!.heardFrom.has(bStatus.fingerprint.toLowerCase()), { timeout: 30_000 }).toBe(true);
  // And A sees the join confirmed everywhere.
  await expect.poll(async () => (await device(a!.window, F))?.confirmation, { timeout: 30_000 }).toBeUndefined();

  // Removing F on A removes it from B too, and A shows the removal confirmed once B has it.
  expect(await a.window.evaluate((fp) => (window as any).clubhouse.annex.removeDevice(fp), F)).toBe(true);
  await expect.poll(async () => await device(b!.window, F), { timeout: 30_000 }).toBeUndefined();
  await expect.poll(async () => await device(a!.window, F), { timeout: 30_000 }).toBeUndefined();
  // B is still a member of A's network.
  expect((await device(a.window, bStatus.fingerprint))?.role).toBe('member');
});
