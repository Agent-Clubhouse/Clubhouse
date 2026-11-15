import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import type { LaunchedApp } from '../e2e/launch';
import type { FakeClis } from '../e2e/chat-fake-cli';
import { generateTestIdentity } from '../e2e/annex-v2/tls-test-utils';
import { readDeliveryCapabilities, waitForDurableDeliveryPath, waitForFakeCliRegistration } from '../e2e/annex-v2/delivery-crash';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('durable delivery readiness without launching Electron', () => {
  it('waits for connection and the real authenticated capability route, without sending input', async () => {
    const senderIdentity = generateTestIdentity();
    const receiverIdentity = generateTestIdentity();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-readiness-unit-'));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    for (const [label, identity] of [['sender', senderIdentity], ['receiver', receiverIdentity]] as const) {
      await fs.mkdir(path.join(root, label));
      await fs.writeFile(path.join(root, label, 'annex-tls-cert.json'), JSON.stringify(identity));
    }
    const requests: string[] = [];
    let available = false;
    const server = https.createServer({
      cert: receiverIdentity.certPem, key: receiverIdentity.keyPem,
      requestCert: true, rejectUnauthorized: true, ca: [senderIdentity.certPem],
    }, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(available ? { deliveryVersion: 1, receiptBoundary: 'runtime-accepted' } : { error: 'delivery_store_unavailable' }));
      available = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const { port } = server.address() as { port: number };
    const receiver = { userDataDir: path.join(root, 'receiver'), window: { evaluate: async () => ({ port }) } } as unknown as LaunchedApp;
    const evaluate = vi.fn().mockResolvedValueOnce([{ fingerprint: 'peer', state: 'connecting' }])
      .mockResolvedValue([{ fingerprint: 'PEER', state: 'connected' }]);
    const sender = { userDataDir: path.join(root, 'sender'), window: { evaluate } } as unknown as LaunchedApp;
    await waitForDurableDeliveryPath(sender, receiver, 'peer', 5_000);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(requests).toEqual(Array(2).fill('POST /api/v1/network/agent-delivery-capabilities'));
    // An unpaired client cannot claim readiness with this endpoint.
    await fs.writeFile(path.join(root, 'sender', 'annex-tls-cert.json'), JSON.stringify(generateTestIdentity()));
    await expect(readDeliveryCapabilities(sender, receiver)).rejects.toThrow();
  });

  it('names missing network readiness in its bounded failure', async () => {
    const app = { window: { evaluate: async () => [] } } as unknown as LaunchedApp;
    await expect(waitForDurableDeliveryPath(app, app, 'peer', 25)).rejects.toThrow('must be connected and advertise a readable durable delivery store');
  });
});

describe('fake CLI registration without spawning a process', () => {
  it('requires the app live-runtime signal and a fresh per-agent report', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce([]).mockResolvedValue(['sender']);
    const report = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not published'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ pid: 101, env: { CLUBHOUSE_AGENT_ID: 'sender' } })
      .mockResolvedValueOnce({ pid: 202, env: { CLUBHOUSE_AGENT_ID: 'other' } })
      .mockResolvedValue({ pid: 202, env: { CLUBHOUSE_AGENT_ID: 'sender' } });
    const app = { window: { evaluate } } as unknown as LaunchedApp;
    const fakes = { report } as unknown as FakeClis;
    expect(await waitForFakeCliRegistration(app, fakes, 'sender', 101, 10_000)).toMatchObject({ pid: 202 });
    expect(evaluate).toHaveBeenCalledTimes(5);
    expect(report).toHaveBeenCalledTimes(4);
    expect(report).toHaveBeenCalledWith('claude', 'sender');
  });

  it('reports the agent and old PID when only a stale report is available', async () => {
    const app = { window: { evaluate: async () => ['sender'] } } as unknown as LaunchedApp;
    const fakes = { report: async () => ({ pid: 101, env: { CLUBHOUSE_AGENT_ID: 'sender' } }) } as unknown as FakeClis;
    await expect(waitForFakeCliRegistration(app, fakes, 'sender', 101, 25)).rejects.toThrow('fresh fake Claude CLI process after PID 101');
  });

  it('does not hide corrupt reports as startup delays', async () => {
    const app = { window: { evaluate: async () => ['sender'] } } as unknown as LaunchedApp;
    const fakes = { report: async () => { throw new SyntaxError('corrupt report'); } } as unknown as FakeClis;
    await expect(waitForFakeCliRegistration(app, fakes, 'sender')).rejects.toThrow('corrupt report');
  });
});
