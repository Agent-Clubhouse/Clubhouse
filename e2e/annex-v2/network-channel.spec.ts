/**
 * Annex Network stage 3 (#3060): the membership channel.
 *
 * - Two desktops pair for real, and each then hears the other on `/network`.
 * - A paired identity that sends anything but membership on `/network` (a
 *   terminal input, an agent start) is cut off with 4400, and the satellite
 *   runs nothing.
 * - A stranger can't open the channel at all.
 */
import { test, expect, type Page } from '@playwright/test';
import WebSocket from 'ws';
import * as crypto from 'crypto';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import { enableAnnexViaPreload, pairOverTls } from './helpers';
import { generateTestIdentity, type TestIdentity } from './tls-test-utils';

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

function status(page: Page): Promise<{ fingerprint: string; port: number; pin: string; pairingUrl?: string }> {
  return page.evaluate(() => (window as any).clubhouse.annex.getStatus());
}

async function membersOn(page: Page): Promise<Array<{ fingerprint: string; connected: boolean; name: string }>> {
  return page.evaluate(() => (window as any).clubhouse.annex.listNetworkMembers());
}

function openNetwork(port: number, identity: TestIdentity | null): WebSocket {
  return new WebSocket(`wss://127.0.0.1:${port}/network`, {
    ...(identity ? { cert: identity.certPem, key: identity.keyPem } : {}),
    rejectUnauthorized: false,
  });
}

function closeOf(ws: WebSocket, timeout = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('channel stayed open')), timeout);
    ws.on('error', () => { /* the close says what happened */ });
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
}

test('two desktops hear each other on the membership channel', async () => {
  const { satellite, controller } = handles;
  let link: string | undefined;
  await expect.poll(async () => { link = (await status(satellite.window)).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  expect(await controller.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), url.toString())).toMatchObject({ success: true });

  const sat = await status(satellite.window);
  const ctrl = await status(controller.window);
  const heard = async (page: Page, fingerprint: string) =>
    (await membersOn(page)).find((m) => m.fingerprint.toLowerCase() === fingerprint.toLowerCase())?.connected ?? false;
  await expect.poll(() => heard(satellite.window, ctrl.fingerprint), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => heard(controller.window, sat.fingerprint), { timeout: 30_000 }).toBe(true);
});

test('anything but membership closes the channel, and nothing runs', async () => {
  const sat = await status(handles.satellite.window);
  const identity = generateTestIdentity();
  await pairOverTls('127.0.0.1', sat.port, (await status(handles.satellite.window)).pin, identity);

  const hello = {
    v: 1,
    type: 'hello',
    member: {
      fingerprint: identity.fingerprint,
      publicKey: identity.ed25519PublicKeyBase64,
      // Colon-separated, as the protocol carries it.
      certFingerprint: new crypto.X509Certificate(identity.certPem).fingerprint256,
      name: 'Test desktop', icon: 'computer', color: 'indigo', kind: 'desktop', hosts: [], joinedAt: new Date().toISOString(),
    },
  };

  for (const control of [
    { type: 'pty:input', payload: { agentId: 'any', data: 'echo should-not-run\n' } },
    { type: 'agent:spawn', payload: { projectId: 'any' } },
    { v: 1, type: 'hello', member: { ...hello.member, fingerprint: 'ab:'.repeat(15) + 'ab' } },
  ]) {
    const ws = openNetwork(sat.port, identity);
    const closed = closeOf(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.send(JSON.stringify(control));
    expect(await closed).toMatchObject({ code: 4400 });
  }

  // Membership is accepted: the satellite says hello back, and lists itself.
  const ws = openNetwork(sat.port, identity);
  const messages: Array<{ type: string }> = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(JSON.stringify(hello));
  await expect.poll(() => messages.map((m) => m.type), { timeout: 10_000 }).toEqual(['hello', 'members']);
  ws.close();
});

test('a stranger cannot open the channel', async () => {
  const sat = await status(handles.satellite.window);
  const stranger = openNetwork(sat.port, generateTestIdentity());
  const outcome = await new Promise<number>((resolve) => {
    stranger.on('error', () => { /* refused */ });
    stranger.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    stranger.once('open', () => resolve(101));
  });
  expect(outcome).toBe(401);
});
