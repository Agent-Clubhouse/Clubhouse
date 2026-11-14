import { handoffE2eDiagnostics } from '../../test/handoff-e2e-diagnostics';
import { isTerminalHandoff, type Handoff } from '../../src/shared/handoffs';
/**
 * Agents across machines (#3064, #3334).
 *
 * Two desktops, each with a durable chat agent over the fake Claude CLI (a
 * recorded fixture that opens a session and goes quiet: no model is called,
 * and any prompt lands in the fake's report). The first pairs with the second
 * and the person connects its agent to the other one. Acting as the first
 * agent over its MCP bridge, the test sends a message once the second computer
 * has the connection: it reaches the second computer's agent with the sender's
 * name and machine. A controlled crash proves the durable-receipt/replay
 * boundary; a separate native SDK fixture proves runtime input, not model execution.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { buildChatScript, writeChatScript } from '../../src/main/orchestrators/adapters/testing/chat-script';
import type { DeliveryFile } from '../../src/main/services/annex-delivery-store';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
import { launchApp, type LaunchedApp } from '../launch';
import { assertDisposableProfile, createDisposableProfile, type DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';
import { terminateOwnedProcess } from '../owned-process-receipts';
import { addProject, assertRunLayout, createDurableAgent } from '../smoke-helpers';
import { isNewLayout } from '../layout';
import { SDK_FIXTURE_ENV, writeAuthenticatedSdkFixture } from '../chat-rich/copilot-sdk-fixture';
import { enableAnnexViaPreload } from './helpers';
import { armDeliveryCommitBarrier, observeDeliveryRequests, readOwnedSenderIdentity, restoreDeliveryInstrumentation, type DeliveryBoundary } from './delivery-crash';

let fakesHere: FakeClis | undefined;
let fakesThere: FakeClis | undefined;
let scratch: string | undefined;
let here: LaunchedApp | undefined;
let there: LaunchedApp | undefined;
const profiles: DisposableProfile[] = [];

test.setTimeout(300_000);

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

async function killOwnedDesktop(app: LaunchedApp, child: ChildProcess, pid: number | undefined, profile: DisposableProfile, expectedMainPid?: number): Promise<void> {
  if (app.electronApp.process() !== child || child.pid !== pid || !Number.isSafeInteger(pid) || !pid || pid <= 0 || pid === process.pid
    || app.profile !== profile || app.userDataDir !== profile.userDataDir) throw new Error('Owned desktop identity changed before termination');
  if (exited(child)) {
    if (expectedMainPid !== undefined) throw new Error('Owned sender exited before its required crash');
    return;
  }
  assertDisposableProfile(profile);
  const main = await readOwnedSenderIdentity(app);
  if (app.electronApp.process() !== child || child.pid !== pid || app.profile !== profile
    || (expectedMainPid !== undefined && main.pid !== expectedMainPid)) throw new Error('Owned sender changed before its required crash');
  await terminateOwnedProcess(child, () => {
    if (!process.kill(main.pid, 'SIGKILL')) throw new Error('Owned sender termination was refused');
    console.log('[e2e owned-sender]', JSON.stringify({ ...main, signal: 'SIGKILL' }));
  });
  if (!exited(child)) throw new Error('Owned desktop termination did not observe process exit');
}

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  const errors: unknown[] = [];
  const child = app.electronApp.process();
  const pid = child.pid;
  const profile = app.profile;
  try {
    if (!exited(child)) await restoreDeliveryInstrumentation(app);
  } catch (error) {
    errors.push(error);
  }
  try {
    await app.electronApp.close();
    if (!exited(child)) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  } catch (error) {
    if (!exited(child)) {
      errors.push(error);
      try { await killOwnedDesktop(app, child, pid, profile); }
      catch (terminationError) { errors.push(terminationError); }
    }
  }
  if (exited(child)) untrackOpenApp(app.electronApp);
  else errors.push(new Error('Owned desktop is still live; retaining the entire fixture cohort'));
  if (errors.length) throw new AggregateError(errors, 'Owned Annex desktop cleanup failed');
}

test.afterEach(async () => {
  const info = test.info();
  const errors: unknown[] = [];
  try {
    if (scratch) {
      for (const name of ['delivery-boundary.json', 'received-call-ids.jsonl']) {
        const file = path.join(scratch, name);
        if (fs.existsSync(file)) await info.attach(name, { path: file, contentType: name.endsWith('jsonl') ? 'application/x-ndjson' : 'application/json' });
      }
    }
    for (const [label, app] of [['sender', here], ['receiver', there]] as const) {
      if (!app) continue;
      const file = path.join(app.userDataDir, 'annex-agent-outbox.json');
      if (!fs.existsSync(file)) continue;
      const saved: DeliveryFile = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      await info.attach(`${label}-delivery-state`, { body: JSON.stringify({
        outbox: saved.outbox.map((row) => row.id),
        inbox: saved.inbox.map((row) => ({ callId: row.key.split('/').pop(), state: row.state })),
        deliveries: saved.deliveries.map(({ callId, state, attempts }) => ({ callId, state, attempts })),
      }), contentType: 'application/json' });
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const children = [here, there].filter((app): app is LaunchedApp => app !== undefined).map((app) => app.electronApp.process());
    const closed = await Promise.allSettled([close(here), close(there)]);
    for (const result of closed) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (children.some((child) => !exited(child))) {
      errors.push(new Error('Fixture cleanup withheld because an owned desktop has not exited'));
    } else {
      const disposed = await Promise.allSettled(profiles.map(async (profile) => profile.dispose()));
      for (const result of disposed) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
      if (disposed.some((result) => result.status === 'rejected') || profiles.some((profile) => !profile.disposed)) {
        errors.push(new Error('Fixture cleanup withheld because an owned profile could not be disposed; retaining the remaining cohort'));
      } else {
        profiles.length = 0;
        here = undefined;
        there = undefined;
        const cleaned = await Promise.allSettled([
          fakesHere?.cleanup(),
          fakesThere?.cleanup(),
          ...(scratch ? [fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })] : []),
        ]);
        for (const result of cleaned) {
          if (result.status === 'rejected') errors.push(result.reason);
        }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned Annex cleanup failed after preserving test evidence');
});

/** A fixture that opens a session and then goes quiet: a prompt is recorded as `unexpected`. */
async function quietFixture(dir: string): Promise<string> {
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  const file = path.join(dir, 'quiet.jsonl');
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** A minimal MCP client over the bridge, as the agent the credentials belong to. */
async function connectMcp(env: Record<string, string | null>) {
  const url = `http://127.0.0.1:${env.CLUBHOUSE_MCP_PORT}/mcp/${env.CLUBHOUSE_AGENT_ID}`;
  let sessionId: string | null = null;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clubhouse-Nonce': env.CLUBHOUSE_HOOK_NONCE ?? '',
        ...(sessionId && { 'Mcp-Session-Id': sessionId }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    return (await res.json()).result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  return {
    toolNames: async (): Promise<string[]> => (await rpc('tools/list')).tools.map((t: { name: string }) => t.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const result: McpToolResult = await rpc('tools/call', { name, arguments: args });
      return { isError: !!result.isError, text: result.content[0].text as string, result };
    },
  };
}

async function launchDesktop(label: string, fakes: FakeClis, deviceName: string, orchestrator = 'claude-code'): Promise<LaunchedApp> {
  const profile = createDisposableProfile({ label });
  profiles.push(profile);
  const app = await launchApp({
    profile,
    label,
    args: ['--disable-gpu'],
    userDataFiles: {
      'orchestrator-settings.json': { enabled: [orchestrator], autoDetected: true },
      'chat-runtime-settings.json': { [orchestrator]: { mode: 'chat', ...(orchestrator === 'claude-code' && { driver: 'claude_stream_json' }) } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName, alias: deviceName, icon: 'computer', color: 'indigo', autoReconnect: true },
    },
    env: fakes.env,
  });
  try {
    await assertRunLayout(app.window);
  } catch (err) {
    untrackOpenApp(app.electronApp);
    await app.electronApp.close().catch((): undefined => undefined);
    throw err;
  }
  return app;
}

/** A durable chat agent, started: returns its id. */
async function startAgent(app: LaunchedApp, dir: string, name: string, orchestrator = 'claude-code'): Promise<string> {
  const w = app.window;
  await addProject(app.electronApp, w, dir);
  const id = await createDurableAgent(w, { projectName: path.basename(dir), name, orchestrator });
  // Classic opens the agent from its row; the new layout opens a created agent itself.
  if (!(await isNewLayout(w))) await w.locator(`[data-testid="agent-item-${id}"]`).click();
  const chat = w.locator(`[data-testid="chat-view"][data-agent-pane="${id}"][data-view-context="main"]`);
  await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  return id;
}

const fingerprintOf = async (w: Page): Promise<string> =>
  ((await w.evaluate(() => (window as any).clubhouse.annex.getStatus())).fingerprint as string).toLowerCase();

async function pairDesktops(sender: LaunchedApp, receiver: LaunchedApp, senderId: string, receiverId: string) {
  await enableAnnexViaPreload(receiver.window);
  await enableAnnexViaPreload(sender.window);
  let link = '';
  await expect.poll(async () => { link = (await receiver.window.evaluate(() => window.clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!link; }, { timeout: 15_000 }).toBe(true);
  const pairing = new URL(link);
  pairing.searchParams.delete('host');
  pairing.searchParams.append('host', '127.0.0.1');
  expect(await sender.window.evaluate((value) => window.clubhouse.annexClient.pairWithLink(value), pairing.toString())).toMatchObject({ success: true });
  const receiverFingerprint = await fingerprintOf(receiver.window);
  const senderFingerprint = await fingerprintOf(sender.window);
  await expect.poll(async () => {
    const satellites: Array<{ fingerprint: string; state: string }> = await sender.window.evaluate(() => window.clubhouse.annexClient.getSatellites());
    return satellites.find((satellite) => satellite.fingerprint.toLowerCase() === receiverFingerprint)?.state;
  }, { timeout: 30_000 }).toBe('connected');
  await sender.window.evaluate(([from, to]) => window.clubhouse.mcpBinding.connectAcrossMachines(from, to, { twoWay: false, name: 'durable-receiver' }), [senderId, `${receiverId}@${receiverFingerprint}`] as const);
  await expect.poll(async () => {
    const grants: Array<{ from: { agentId: string; machineId?: string }; link?: unknown }> = await receiver.window.evaluate((id) => window.clubhouse.mcpBinding.getConnectionGrants(id), receiverId);
    return grants.some((grant) => grant.from.agentId === senderId && grant.from.machineId === senderFingerprint && !!grant.link);
  }, { timeout: 30_000 }).toBe(true);
  return { senderFingerprint, receiverFingerprint };
}

test('an agent messages an agent on another computer through the connection the person made', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agents-across-'));
  const fixture = await quietFixture(scratch);
  fakesHere = await installFakeClis({ claude: fixture });
  fakesThere = await installFakeClis({ claude: fixture });
  for (const d of ['here-project', 'there-project']) await fs.promises.mkdir(path.join(scratch, d));
  here = await launchDesktop('here', fakesHere, 'Desk');
  there = await launchDesktop('there', fakesThere, 'Studio');

  const senderId = await startAgent(here, path.join(scratch, 'here-project'), `sender-${Date.now()}`);
  const receiverName = `receiver-${Date.now()}`;
  const receiverId = await startAgent(there, path.join(scratch, 'there-project'), receiverName);
  await expect.poll(async () => (await fakesHere!.report('claude').catch((): undefined => undefined))?.env.CLUBHOUSE_AGENT_ID, { timeout: 20_000 }).toBe(senderId);

  // The first computer pairs with the second.
  await enableAnnexViaPreload(there.window);
  await enableAnnexViaPreload(here.window);
  let link: string | undefined;
  await expect.poll(async () => { link = (await there!.window.evaluate(() => (window as any).clubhouse.annex.getStatus())).pairingUrl; return !!link; }, { timeout: 15_000 }).toBe(true);
  const url = new URL(link!);
  url.searchParams.delete('host');
  url.searchParams.append('host', '127.0.0.1');
  expect(await here.window.evaluate((l) => (window as any).clubhouse.annexClient.pairWithLink(l), url.toString())).toMatchObject({ success: true });
  const thereFp = await fingerprintOf(there.window);
  const hereFp = await fingerprintOf(here.window);
  await expect.poll(async () => {
    const sats: Array<{ fingerprint: string; state: string }> = await here!.window.evaluate(() => (window as any).clubhouse.annexClient.getSatellites());
    return sats.find((s) => s.fingerprint.toLowerCase() === thereFp)?.state;
  }, { timeout: 30_000 }).toBe('connected');

  // The person connects the first computer's agent to the second's, one way.
  const address = `${receiverId}@${thereFp}`;
  await here.window.evaluate(([from, to, name]) => (window as any).clubhouse.mcpBinding.connectAcrossMachines(from, to, { twoWay: false, name }), [senderId, address, receiverName] as const);

  // The second computer hears of it: the direction from the first, with the person's link.
  await expect.poll(async () => {
    const grants: Array<{ from: { agentId: string; machineId?: string }; link?: unknown }> = await there!.window.evaluate((id) => (window as any).clubhouse.mcpBinding.getConnectionGrants(id), receiverId);
    return grants.some((g) => g.from.agentId === senderId && g.from.machineId === hereFp && !!g.link);
  }, { timeout: 30_000 }).toBe(true);

  // As the sender: the wire's tools are listed, and its message reaches the other computer.
  const mcp = await connectMcp((await fakesHere.report('claude')).env);
  let sendTool: string | undefined;
  await expect.poll(async () => { sendTool = (await mcp.toolNames()).find((n) => n.endsWith('__send_message')); return !!sendTool; }, { timeout: 20_000 }).toBe(true);
  const sent = await mcp.call(sendTool!, { message: 'hello from the other desk', task_id: 'across1' });
  expect(sent.isError).toBe(false);
  expect(sent.text).toContain('Message sent');

  await expect.poll(async () => {
    const report = await fakesThere!.report('claude').catch((): undefined => undefined);
    const prompts = JSON.stringify(report?.unexpected ?? []);
    return prompts.includes('hello from the other desk') && prompts.includes('on Desk') && prompts.includes('[TASK:across1]');
  }, { timeout: 30_000 }).toBe(true);
});

test('a sender crash after a durable200 replays the same identity once, then preserves FIFO and file bytes', async () => {
  const info = test.info();
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-e2e-delivery-crash-'));
  const quiet = await quietFixture(scratch);
  const receiverFixture = await writeChatScript(scratch, 'receiver', buildChatScript('claude', {
    description: 'Three actual Annex inputs, with completed token-free turns so later FIFO work can run.',
    turns: Array.from({ length: 3 }, (_, i) => ({ steps: [{ type: 'text' as const, text: `Fixture accepted input ${i + 1}.` }] })),
  }));
  fakesHere = await installFakeClis({ claude: quiet });
  fakesThere = await installFakeClis({ claude: receiverFixture.fixture });
  const senderProject = path.join(scratch, 'sender-project');
  const receiverProject = path.join(scratch, 'receiver-project');
  await fs.promises.mkdir(senderProject);
  await fs.promises.mkdir(receiverProject);
  here = await launchDesktop('crash-sender', fakesHere, 'Desk');
  there = await launchDesktop('crash-receiver', fakesThere, 'Studio');
  const senderId = await startAgent(here, senderProject, 'durable-sender');
  const receiverId = await startAgent(there, receiverProject, 'durable-receiver');
  await expect.poll(async () => (await fakesHere!.report('claude')).env.CLUBHOUSE_AGENT_ID).toBe(senderId);
  const oldCliPid = (await fakesHere.report('claude')).pid;
  const { senderFingerprint, receiverFingerprint } = await pairDesktops(here, there, senderId, receiverId);
  let mcp = await connectMcp((await fakesHere.report('claude')).env);
  const send = (await mcp.toolNames()).find((name) => name.endsWith('__send_message'));
  expect(send).toBeTruthy();
  await here.window.evaluate((fingerprint) => window.clubhouse.annexClient.disconnect(fingerprint), receiverFingerprint);
  await expect.poll(async () => {
    const satellites: Array<{ fingerprint: string; state: string }> = await here!.window.evaluate(() => window.clubhouse.annexClient.getSatellites());
    return satellites.find((satellite) => satellite.fingerprint.toLowerCase() === receiverFingerprint)?.state;
  }).toBe('disconnected');
  const firstArgs = { message: 'durable first input', task_id: 'durable-first', idempotency_key: 'durable-first' };
  const secondArgs = { message: 'durable second input', task_id: 'durable-second', idempotency_key: 'durable-second' };
  expect((await mcp.call(send!, firstArgs)).text).toContain('delivery_id=');
  expect((await mcp.call(send!, secondArgs)).text).toContain('delivery_id=');
  const senderStore = path.join(here.userDataDir, 'annex-agent-outbox.json');
  const readSender = async (): Promise<DeliveryFile> => JSON.parse(await fs.promises.readFile(senderStore, 'utf8'));
  const before = await readSender();
  expect(before.outbox).toHaveLength(2);
  expect(before.outbox.map((item) => item.body.args.task_id)).toEqual(['durable-first', 'durable-second']);
  const [firstId, secondId] = before.outbox.map((item) => item.id);
  const boundaryPath = path.join(scratch, 'delivery-boundary.json');
  const requestsPath = path.join(scratch, 'received-call-ids.jsonl');
  await observeDeliveryRequests(there, requestsPath);
  const senderIdentity = await armDeliveryCommitBarrier(here, firstId, boundaryPath);
  await here.window.evaluate((fingerprint) => window.clubhouse.annexClient.connect(fingerprint), receiverFingerprint);
  await expect.poll(() => fs.existsSync(boundaryPath), { timeout: 30_000 }).toBe(true);
  const boundary: DeliveryBoundary = JSON.parse(await fs.promises.readFile(boundaryPath, 'utf8'));
  expect(boundary).toMatchObject({ callId: firstId, status: 200, outboxIds: [firstId, secondId] });
  expect((await readSender()).deliveries.find((row) => row.callId === firstId)).toMatchObject({ state: 'sending', attempts: 1 });
  const receiverStore = path.join(there.userDataDir, 'annex-agent-outbox.json');
  const received: DeliveryFile = JSON.parse(await fs.promises.readFile(receiverStore, 'utf8'));
  const receipt = received.inbox.find((row) => row.key.endsWith(`/${firstId}`));
  expect(receipt).toMatchObject({ state: 'delivered', updatedAt: boundary.receiptAt });
  expect(createHash('sha256').update(JSON.stringify(receipt!.result)).digest('hex')).toBe(boundary.resultHash);
  const profile = here.profile;
  const pid = here.electronApp.process().pid;
  expect(pid).toBe(senderIdentity.launcherPid);
  expect(boundary.launcherPid).toBe(pid);
  expect(boundary.pid).toBe(senderIdentity.pid);
  if (!pid) throw new Error('Owned sender PID is unavailable');
  const closed = here.electronApp.waitForEvent('close');
  const child = here.electronApp.process();
  await Promise.all([closed, killOwnedDesktop(here, child, pid, profile, boundary.pid)]);
  expect(exited(child)).toBe(true);
  untrackOpenApp(here.electronApp);
  here = undefined;
  const receiverChat = there.window.locator(`[data-testid="chat-view"][data-agent-pane="${receiverId}"][data-view-context="main"]`);
  await expect(receiverChat).toHaveAttribute('data-state', 'idle');
  here = await launchApp({ profile, label: 'same-sender-profile', args: ['--disable-gpu'], env: fakesHere.env });
  expect(here.userDataDir).toBe(profile.userDataDir);
  expect(profile.disposed).toBe(false);
  expect(await fingerprintOf(here.window)).toBe(senderFingerprint);
  await expect.poll(async () => (await readSender()).outbox.length, { timeout: 30_000 }).toBe(0);
  const after = await readSender();
  expect(after.deliveries.find((row) => row.callId === firstId)).toMatchObject({ state: 'delivered', attempts: 2 });
  expect(after.deliveries.find((row) => row.callId === secondId)).toMatchObject({ state: 'delivered', attempts: 1 });
  await here.window.evaluate(async ({ id, project }) => {
    const running = await window.clubhouse.agent.getRunningStatuses([id]);
    if (!running.includes(id)) await window.clubhouse.agent.spawnAgent({ agentId: id, projectPath: project, cwd: project, kind: 'durable', orchestrator: 'claude-code' });
  }, { id: senderId, project: senderProject });
  await expect.poll(async () => {
    const report = await fakesHere!.report('claude');
    return report.pid !== oldCliPid && report.env.CLUBHOUSE_AGENT_ID === senderId;
  }).toBe(true);
  mcp = await connectMcp((await fakesHere.report('claude')).env);
  const duplicate = await mcp.call(send!, firstArgs);
  expect(duplicate.isError).toBe(false);
  expect(createHash('sha256').update(JSON.stringify(duplicate.result)).digest('hex')).toBe(boundary.resultHash);
  const statusTool = (await mcp.toolNames()).find((name) => name.endsWith('get_delivery'));
  expect(statusTool).toBeTruthy();
  expect(JSON.parse((await mcp.call(statusTool!, { delivery_id: firstId })).text)).toMatchObject({ callId: firstId, state: 'delivered', attempts: 2 });
  await expect(receiverChat).toHaveAttribute('data-state', 'idle');
  const fileTool = (await mcp.toolNames()).find((name) => name.endsWith('__send_file'));
  expect(fileTool).toBeTruthy();
  const content = 'Exact file bytes.\r\nSecond line.\n';
  const fileArgs = { content, filename: 'durable.txt', task_id: 'durable-file', idempotency_key: 'durable-file' };
  const fileResult = await mcp.call(fileTool!, fileArgs);
  expect(fileResult.isError).toBe(false);
  const filePath = /path=(.+)$/.exec(fileResult.text)?.[1];
  if (!filePath) throw new Error('File receipt did not name the fixture file');
  const temp = await there.electronApp.evaluate(({ app }) => app.getPath('temp'));
  expect(path.dirname(path.dirname(filePath))).toBe(temp);
  expect(path.basename(path.dirname(filePath))).toMatch(/^clubhouse-a2a-/);
  expect(path.basename(filePath)).toMatch(/^[0-9a-f-]{36}\.md$/);
  expect(await fs.promises.readFile(filePath)).toEqual(Buffer.from(content));
  expect(await mcp.call(fileTool!, fileArgs)).toEqual(fileResult);
  await expect.poll(async () => {
    const events = await there!.window.evaluate((id) => window.clubhouse.chat.readTranscript(id), receiverId);
    return events.filter((event) => event.type === 'user_message' && event.data.source === 'mcp')
      .map((event) => event.type === 'user_message' ? event.data.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('') : '');
  }).toEqual([expect.stringContaining('[TASK:durable-first]'), expect.stringContaining('[TASK:durable-second]'), expect.stringContaining('[TASK:durable-file]')]);
  await expect.poll(async () => (await fakesThere!.report('claude')).complete).toBe(true);
  expect((await fakesThere.report('claude')).unexpected).toEqual([]);
  expect((await fakesThere.report('claude')).mismatch).toBeNull();
  const ids = (await fs.promises.readFile(requestsPath, 'utf8')).trim().split('\n').map((line) => (JSON.parse(line) as { callId: string }).callId);
  expect(ids.slice(0, 3)).toEqual([firstId, firstId, secondId]);
  expect(ids.filter((id) => id === firstId)).toHaveLength(2);
  const persistedReceipt: DeliveryFile = JSON.parse(await fs.promises.readFile(receiverStore, 'utf8'));
  expect(persistedReceipt.inbox.find((row) => row.key === receipt!.key)).toEqual(receipt);
  const otherId = await createDurableAgent(here.window, { projectName: path.basename(senderProject), name: 'other-delivery-caller', orchestrator: 'claude-code' });
  await expect.poll(async () => (await fakesHere!.report('claude')).env.CLUBHOUSE_AGENT_ID).toBe(otherId);
  const otherMcp = await connectMcp((await fakesHere.report('claude')).env);
  expect(await otherMcp.call(statusTool!, { delivery_id: firstId })).toMatchObject({ isError: true, text: 'No retained delivery with that id belongs to you.' });
  await info.attach('durable-replay-witness', { body: JSON.stringify({ firstId, secondId, attempts: [2, 1], actualRequestIds: ids, runtimeInputs: 3, fileBytes: Buffer.byteLength(content), fileHash: createHash('sha256').update(content).digest('hex') }), contentType: 'application/json' });
});

test('default native Copilot SDK fixtures accept one remote input and replay a stable delivery without a second input', async () => {
  const info = test.info();
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-e2e-delivery-sdk-'));
  const senderFixture = await writeChatScript(scratch, 'sdk-sender', buildChatScript('copilot', { description: 'Native SDK sender with no model turns.', turns: [] }));
  const receiverFixture = await writeChatScript(scratch, 'sdk-receiver', buildChatScript('copilot', {
    description: 'One token-free native SDK Annex input.',
    turns: [{ steps: [{ type: 'text', text: 'Synthetic fixture response, not model execution.' }] }],
  }));
  fakesHere = await installFakeClis({ copilot: await writeAuthenticatedSdkFixture(scratch, senderFixture.fixture) });
  fakesThere = await installFakeClis({ copilot: await writeAuthenticatedSdkFixture(scratch, receiverFixture.fixture) });
  const senderHome = path.join(scratch, 'sender-sdk-home');
  const receiverHome = path.join(scratch, 'receiver-sdk-home');
  for (const [fakes, home] of [[fakesHere, senderHome], [fakesThere, receiverHome]] as const) {
    await fs.promises.mkdir(path.join(home, 'session-state'), { recursive: true });
    fakes.env = { ...fakes.env, ...SDK_FIXTURE_ENV, COPILOT_HOME: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home };
  }
  const senderProject = path.join(scratch, 'sdk-sender-project');
  const receiverProject = path.join(scratch, 'sdk-receiver-project');
  await fs.promises.mkdir(senderProject);
  await fs.promises.mkdir(receiverProject);
  here = await launchDesktop('native-sdk-sender', fakesHere, 'Desk', 'copilot-cli');
  there = await launchDesktop('native-sdk-receiver', fakesThere, 'Studio', 'copilot-cli');
  const senderId = await startAgent(here, senderProject, 'sdk-sender', 'copilot-cli');
  const receiverId = await startAgent(there, receiverProject, 'sdk-receiver', 'copilot-cli');
  for (const [app, fakes, id, home] of [[here, fakesHere, senderId, senderHome], [there, fakesThere, receiverId, receiverHome]] as const) {
    const report = await fakes.report('copilot', id);
    expect(report.protocol).toBe('copilot-sdk');
    expect(report.argv).toEqual(expect.arrayContaining(['--headless', '--port', '0']));
    expect(report.env.COPILOT_HOME).toBe(home);
    expect(report.env.CLUBHOUSE_AGENT_ID).toBe(id);
    await expect.poll(async () => {
      const events = await app.window.evaluate((agentId) => window.clubhouse.chat.readTranscript(agentId), id);
      return events.filter((event) => event.type === 'session_started').pop()?.data.driver;
    }).toBe('copilot_sdk');
  }
  await pairDesktops(here, there, senderId, receiverId);
  const requestsPath = path.join(scratch, 'received-call-ids.jsonl');
  await observeDeliveryRequests(there, requestsPath);
  const mcp = await connectMcp((await fakesHere.report('copilot', senderId)).env);
  const send = (await mcp.toolNames()).find((name) => name.endsWith('__send_message'));
  expect(send).toBeTruthy();
  const args = { message: 'one native SDK fixture input', task_id: 'native-sdk-delivery', idempotency_key: 'native-sdk-delivery' };
  const first = await mcp.call(send!, args);
  expect(first.isError).toBe(false);
  expect(await mcp.call(send!, args)).toEqual(first);
  await expect.poll(async () => (await fakesThere!.report('copilot', receiverId)).complete).toBe(true);
  const report = await fakesThere.report('copilot', receiverId);
  expect(report.mismatch).toBeNull();
  expect(report.unexpected).toEqual([]);
  const input = await there.window.evaluate(async (id) => (await window.clubhouse.chat.readTranscript(id))
    .filter((event) => event.type === 'user_message' && event.data.source === 'mcp'), receiverId);
  expect(input).toHaveLength(1);
  const calls = (await fs.promises.readFile(requestsPath, 'utf8')).trim().split('\n');
  expect(calls).toHaveLength(1);
  await info.attach('native-sdk-replay-witness', { body: JSON.stringify({ driver: 'copilot_sdk', runtimeInputs: input.length, actualRequests: calls.length, realLogin: false, modelExecution: false }), contentType: 'application/json' });
});

test('capacity probes require device.read and return coarse results for both desktops', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'handoff-capacity-'));
  const fixture = await quietFixture(scratch);
  fakesHere = await installFakeClis({ claude: fixture });
  fakesThere = await installFakeClis({ claude: fixture });
  const senderProject = path.join(scratch, 'sender-project');
  const receiverProject = path.join(scratch, 'receiver-project');
  await fs.promises.mkdir(senderProject);
  await fs.promises.mkdir(receiverProject);
  here = await launchDesktop('capacity-sender', fakesHere, 'Desk');
  there = await launchDesktop('capacity-receiver', fakesThere, 'Studio');
  const senderId = await startAgent(here, senderProject, 'capacity-sender');
  const receiverId = await startAgent(there, receiverProject, 'capacity-receiver');
  const { senderFingerprint, receiverFingerprint } = await pairDesktops(here, there, senderId, receiverId);
  const mcp = await connectMcp((await fakesHere.report('claude')).env);
  expect((await mcp.toolNames()).some((name) => name.endsWith('probe_capacity'))).toBe(false);
  await here.window.evaluate(async ({ project, id }) => {
    await window.clubhouse.agent.setGrant(project, id, { action: 'device.read', target: { kind: 'app' }, mode: 'allow' });
  }, { project: senderProject, id: senderId });
  let tool = '';
  await expect.poll(async () => { tool = (await mcp.toolNames()).find((name) => name.endsWith('probe_capacity')) ?? ''; return !!tool; }).toBe(true);
  const result = await mcp.call(tool, {});
  expect(result.isError).toBe(false);
  const values = JSON.parse(result.text);
  expect(values.map((value: { machine: string }) => value.machine).sort()).toEqual([senderFingerprint, receiverFingerprint].sort());
  for (const value of values) {
    expect(value).toMatchObject({ online: true, agents: { idleDurable: 1 }, accepting_handoffs: true });
    expect(Object.keys(value).sort()).toEqual(['machine', 'online', 'sampledAt', 'lastSeen', 'agents', 'load', 'disk', 'providers', 'accepting_handoffs'].sort());
    expect(['low', 'medium', 'high']).toContain(value.load);
    expect(['ample', 'limited', 'low']).toContain(value.disk);
    expect(Object.values(value.providers).every((band) => ['available', 'limited', 'unavailable', 'unknown'].includes(String(band)))).toBe(true);
  }
  await there.window.evaluate(async () => {
    const settings = await window.clubhouse.annex.getSettings();
    await window.clubhouse.annex.saveSettings({ ...settings, enableServer: false, enableClient: false });
  });
  await expect.poll(async () => {
    const answer = await mcp.call(tool, { machine: receiverFingerprint });
    return answer.isError ? null : JSON.parse(answer.text)[0]?.online;
  }, { timeout: 20_000 }).toBe(false);
  await here.window.evaluate(async ({ project, id }) => {
    await window.clubhouse.agent.setGrant(project, id, { action: 'device.read', target: { kind: 'app' }, mode: 'off' });
  }, { project: senderProject, id: senderId });
  expect((await mcp.call(tool, {})).isError).toBe(true);
});

test('accepted handoff transfers a selected ignored file over 512 KiB and publishes before waking the receiver', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'handoff-agreement-'));
  const fixture = await quietFixture(scratch);
  fakesHere = await installFakeClis({ claude: fixture });
  fakesThere = await installFakeClis({ claude: fixture });
  const senderProject = path.join(scratch, 'handoff-sender-project');
  const receiverProject = path.join(scratch, 'handoff-receiver-project');
  await fs.promises.mkdir(senderProject);
  await fs.promises.mkdir(receiverProject);
  const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '0' } });
  const emptyGitConfig = path.join(scratch, 'empty-git-config'); await fs.promises.writeFile(emptyGitConfig, '');
  for (const repo of [senderProject, receiverProject]) {
    await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'test@example.invalid');
    await fs.promises.writeFile(path.join(repo, 'work.txt'), 'base'); await fs.promises.writeFile(path.join(repo, '.gitignore'), 'fixtures/\n.clubhouse/\n');
    await git(repo, 'add', '.'); await git(repo, '-c', `core.hooksPath=${path.join(scratch, 'no-hooks')}`, 'commit', '-qm', 'Base');
    await git(repo, 'config', 'remote.origin.url', 'https://example.invalid/handoff.git');
    // Deterministic local failure exercises the bundle fallback, without an external network call.
    await git(repo, 'config', `url.${pathToFileURL(path.join(scratch, 'absent.git')).href}.insteadOf`, 'https://example.invalid/handoff.git');
  }
  for (const fake of [fakesHere, fakesThere]) fake.env = { ...fake.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '0' };
  here = await launchDesktop('handoff-sender', fakesHere, 'Desk');
  there = await launchDesktop('handoff-receiver', fakesThere, 'Studio');
  const senderId = await startAgent(here, senderProject, 'handoff-sender');
  const receiverId = await startAgent(there, receiverProject, 'handoff-receiver');
  const { senderFingerprint, receiverFingerprint } = await pairDesktops(here, there, senderId, receiverId);
  const senderMcp = await connectMcp((await fakesHere.report('claude')).env);
  const receiverMcp = await connectMcp((await fakesThere.report('claude')).env);
  expect((await senderMcp.toolNames()).some((name) => name.endsWith('offer_handoff'))).toBe(false);
  for (const [app, project, agentId, action] of [[here, senderProject, senderId, 'handoff.offer'], [there, receiverProject, receiverId, 'handoff.accept']] as const) {
    await app.window.evaluate(async ({ project, agentId, action }) => {
      await window.clubhouse.agent.setGrant(project, agentId, { action, target: { kind: 'any' }, mode: 'allow' });
    }, { project, agentId, action });
  }
  const tool = async (mcp: typeof senderMcp, suffix: string) => {
    let name = '';
    await expect.poll(async () => { name = (await mcp.toolNames()).find((candidate) => candidate.endsWith(suffix)) ?? ''; return !!name; }).toBe(true);
    return name;
  };
  const senderConfig = await here.window.evaluate(({ project, id }) => window.clubhouse.agent.getDurableConfig(project, id), { project: senderProject, id: senderId });
  const sourceRoot = senderConfig.worktreePath || senderProject;
  const large = Buffer.alloc(600 * 1024, 17);
  await fs.promises.mkdir(path.join(sourceRoot, 'fixtures'), { recursive: true });
  await fs.promises.writeFile(path.join(sourceRoot, 'work.txt'), 'final tracked bytes');
  await fs.promises.writeFile(path.join(sourceRoot, 'fixtures', 'selected.bin'), large);
  await fs.promises.writeFile(path.join(sourceRoot, 'fixtures', 'excluded.bin'), 'unselected');
  await fs.promises.writeFile(path.join(receiverProject, 'work.txt'), 'person dirty work');
  const prepare = await tool(senderMcp, 'prepare_handoff');
  await fs.promises.writeFile(path.join(sourceRoot, 'blocked.txt'), `ghp_${'a'.repeat(36)}`);
  const blocked = await senderMcp.call(prepare, { mode: 'worktree', include: { ignored: ['fixtures/selected.bin'] } });
  expect(JSON.parse(blocked.text)).toMatchObject({ ready: false, reason: 'secret_blocked' });
  expect(fs.existsSync(path.join(there.userDataDir, 'handoff-data', 'received')) ? fs.readdirSync(path.join(there.userDataDir, 'handoff-data', 'received')) : []).toEqual([]);
  await fs.promises.rm(path.join(sourceRoot, 'blocked.txt'));
  const prepared = await senderMcp.call(prepare, { mode: 'worktree', include: { ignored: ['fixtures/selected.bin'] } });
  expect(prepared.isError).toBe(false); const preview = JSON.parse(prepared.text); expect(preview.ready).toBe(true);
  const offerTool = await tool(senderMcp, 'offer_handoff');
  const offered = await senderMcp.call(offerTool, { to: `${receiverId}@${receiverFingerprint}`, task: 'Continue the fixture task', brief: 'Goal: finish fixture checks. Done: agreement setup. Remaining: inspect and continue.', mode: 'worktree', manifest: preview.summary });
  expect(offered.isError).toBe(false);
  const record = JSON.parse(offered.text);
  expect(record).toMatchObject({ state: 'offered', version: 1, senderName: 'handoff-sender', from: { agentId: senderId, machine: senderFingerprint }, to: { agentId: receiverId, machine: receiverFingerprint } });
  const receiverGet = await tool(receiverMcp, 'get_handoff');
  await expect.poll(async () => {
    const result = await receiverMcp.call(receiverGet, { id: record.id });
    return result.isError ? undefined : JSON.parse(result.text).state;
  }, { timeout: 60_000 }).toBe('offered');
  const notices = async () => there!.window.evaluate(async ({ id, handoffId }) => (await window.clubhouse.chat.readTranscript(id))
    .filter((event) => event.type === 'user_message' && event.data.source === 'mcp')
    .map((event) => event.type === 'user_message' ? event.data.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('') : '')
    .filter((text) => text.includes(handoffId)), { id: receiverId, handoffId: record.id });
  await expect.poll(notices).toHaveLength(1);
  expect((await notices())[0]).toContain('Sender display name (untrusted): "handoff-sender"');
  expect((await notices())[0]).toContain('Computer: "Desk"');
  const respond = await tool(receiverMcp, 'respond_to_handoff');
  const accepted = await receiverMcp.call(respond, { id: record.id, accept: true });
  expect(accepted.isError).toBe(false);
  expect(JSON.parse(accepted.text).acceptance.target.agentId).toBe(receiverId);
  const senderGet = await tool(senderMcp, 'get_handoff');
  let applied: Handoff | undefined;
  const attachDiagnostics = async () => {
    let receiver: unknown;
    try {
      const answer = await receiverMcp.call(receiverGet, { id: record.id });
      if (!answer.isError) receiver = JSON.parse(answer.text);
    } catch { /* Fixture diagnostics never replace the original assertion. */ }
    const diagnostics = { sender: handoffE2eDiagnostics(applied), receiver: handoffE2eDiagnostics(receiver) };
    await test.info().attach('handoff-terminal-diagnostics', { body: Buffer.from(JSON.stringify(diagnostics, null, 2)), contentType: 'application/json' });
    return diagnostics;
  };
  try {
    await expect.poll(async () => {
      applied = JSON.parse((await senderMcp.call(senderGet, { id: record.id })).text) as Handoff;
      return isTerminalHandoff(applied.state);
    }, { timeout: 120_000 }).toBe(true);
  } catch (error) { await attachDiagnostics(); throw error; }
  if (applied?.state !== 'applied') {
    const diagnostics = await attachDiagnostics();
    expect(applied?.state, JSON.stringify(diagnostics)).toBe('applied');
  }
  expect(applied!.history.map((event) => event.state)).toContain('applying');
  expect(applied!.result!.worktree).not.toBe(receiverProject);
  expect(await fs.promises.readFile(path.join(applied!.result!.worktree, 'fixtures', 'selected.bin'))).toEqual(large);
  expect(fs.existsSync(path.join(applied!.result!.worktree, 'fixtures', 'excluded.bin'))).toBe(false);
  expect(await fs.promises.readFile(path.join(receiverProject, 'work.txt'), 'utf8')).toBe('person dirty work');
  expect((await git(applied!.result!.worktree, 'rev-parse', 'HEAD')).stdout.trim()).toBe(preview.manifest.repo.base);
  await expect.poll(async () => JSON.stringify((await fakesThere!.report('claude')).unexpected)).toContain('Continue in fresh worktree');
  await expect.poll(() => fs.readdirSync(path.join(there!.userDataDir, 'handoff-data', 'received'))).toEqual([]);
  await here.window.evaluate(async ({ project, id }) => window.clubhouse.agent.setGrant(project, id, { action: 'handoff.offer', target: { kind: 'any' }, mode: 'off' }), { project: senderProject, id: senderId });
  expect((await senderMcp.call(offerTool, { to: `${receiverId}@${receiverFingerprint}`, task: 'Refused', brief: 'No grant.', mode: 'worktree' })).isError).toBe(true);
});
