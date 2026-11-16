/**
 * Creating a group project on another computer (#3547, #3552), two desktops over the
 * real Annex Network, on one machine.
 *
 * Studio asks Desk to host a group project. A person's request is always Ask first on
 * Desk: Studio is paired and still creates nothing until a person on Desk allows it.
 * Studio never sees the request, so it can't answer it. A declined request creates
 * nothing; an allowed one creates the group once, on Desk, and Studio then shows a
 * copy of it. Fake CLIs only: no agent or model is started.
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

async function launchDesktop(profile: DisposableProfile, label: string, fakes: FakeClis, deviceName: string): Promise<LaunchedApp> {
  const app = await launchApp({
    profile,
    label,
    args: ['--disable-gpu'],
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      // The host's Dispatcher is where the approval shows; with it off a remote create is refused.
      'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName, alias: deviceName, icon: 'computer', color: 'indigo', autoReconnect: true },
    },
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

interface Outcome { status: string; requestId: string; groupProjectId?: string }
interface Asked { requestId: string; remoteCreateReview?: { name: string } }

const createOn = (w: Page, host: string, name: string, retryOf?: string): Promise<Outcome> =>
  w.evaluate(([h, n, r]) => (window as any).clubhouse.groupProject.createOnHost(h, n, { scope: { level: 'app', reach: 'network' } }, r), [host, name, retryOf] as const);
const namesOn = async (w: Page): Promise<string[]> =>
  ((await w.evaluate(() => (window as any).clubhouse.groupProject.list())) as Array<{ name: string }>).map((p) => p.name);
const askedOn = (w: Page): Promise<Asked[]> => w.evaluate(() => (window as any).clubhouse.agent.listGrantRequests());
const askedFor = async (w: Page, name: string): Promise<Asked | undefined> => (await askedOn(w)).find((r) => r.remoteCreateReview?.name === name);

test('a person on another computer can only ask: the host allows or declines, and nothing is created before', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'network-group-project-remote-create-'));
  const fixture = await quietFixture(scratch);
  fakesDesk = await installFakeClis({ claude: fixture });
  fakesStudio = await installFakeClis({ claude: fixture });
  const deskProfile = createDisposableProfile({ label: 'gprc-desk' });
  const studioProfile = createDisposableProfile({ label: 'gprc-studio' });
  profiles.push(deskProfile, studioProfile);
  desk = await launchDesktop(deskProfile, 'gprc-desk', fakesDesk, 'Desk');
  studio = await launchDesktop(studioProfile, 'gprc-studio', fakesStudio, 'Studio');
  await desk.window.evaluate(() => (window as any).clubhouse.dispatcher.setEnabled(true));

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

  // Desk is offered to Studio as a host once it is online and supports remote create.
  await expect.poll(async () => {
    const hosts: Array<{ machine: string | null; state: string }> = await studio!.window.evaluate(() => (window as any).clubhouse.groupProject.createHosts());
    return hosts.find((h) => h.machine === deskFp)?.state;
  }, { timeout: 30_000 }).toBe('online');

  // Paired is not approved: the request waits, nothing exists on either computer, and only Desk can see it.
  const first = await createOn(studio.window, deskFp, 'Asked first');
  expect(first.status).toBe('waiting');
  await expect.poll(() => askedFor(desk!.window, 'Asked first'), { timeout: 30_000 }).toBeTruthy();
  expect(await askedFor(studio.window, 'Asked first')).toBeUndefined();
  expect(await namesOn(desk.window)).not.toContain('Asked first');
  expect(await namesOn(studio.window)).not.toContain('Asked first');
  // Asking again with the same id is still waiting, and doesn't make a second request.
  expect((await createOn(studio.window, deskFp, 'Asked first', first.requestId)).status).toBe('waiting');
  expect((await askedOn(desk.window)).filter((r) => r.remoteCreateReview?.name === 'Asked first')).toHaveLength(1);

  // A person on Desk allows it: the group is created once, on Desk, and Studio shows a copy.
  const request = (await askedFor(desk.window, 'Asked first'))!;
  expect(await desk.window.evaluate((id) => (window as any).clubhouse.agent.answerGrantRequest(id, true), request.requestId)).toMatchObject({ ok: true });
  let allowed: Outcome | undefined;
  await expect.poll(async () => { allowed = await createOn(studio!.window, deskFp, 'Asked first', first.requestId); return allowed.status; }, { timeout: 60_000 }).toBe('created');
  expect(allowed!.requestId).toBe(first.requestId);
  await expect.poll(async () => (await namesOn(desk!.window)).filter((n) => n === 'Asked first').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await namesOn(studio!.window)).filter((n) => n === 'Asked first').length, { timeout: 30_000 }).toBe(1);
  // The same request is used up: asking again returns the same group and creates no second one.
  expect((await createOn(studio.window, deskFp, 'Asked first', first.requestId)).groupProjectId).toBe(allowed!.groupProjectId);
  expect((await namesOn(desk.window)).filter((n) => n === 'Asked first')).toHaveLength(1);

  // A declined request creates nothing, and needs a new request to ask again.
  const second = await createOn(studio.window, deskFp, 'Asked second');
  expect(second.status).toBe('waiting');
  await expect.poll(() => askedFor(desk!.window, 'Asked second'), { timeout: 30_000 }).toBeTruthy();
  const declined = (await askedFor(desk.window, 'Asked second'))!;
  expect(await desk.window.evaluate((id) => (window as any).clubhouse.agent.answerGrantRequest(id, false), declined.requestId)).toMatchObject({ ok: true });
  await expect.poll(async () => (await createOn(studio!.window, deskFp, 'Asked second', second.requestId)).status, { timeout: 60_000 }).toBe('declined');
  expect(await namesOn(desk.window)).not.toContain('Asked second');
  expect(await namesOn(studio.window)).not.toContain('Asked second');
});
