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
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { buildChatScript, writeChatScript } from '../../src/main/orchestrators/adapters/testing/chat-script';
import type { DeliveryFile } from '../../src/main/services/annex-delivery-store';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
import { launchApp, type LaunchedApp } from '../launch';
import type { DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';
import { addProject, assertRunLayout, createDurableAgent } from '../smoke-helpers';
import { isNewLayout } from '../layout';
import { SDK_FIXTURE_ENV, writeAuthenticatedSdkFixture } from '../chat-rich/copilot-sdk-fixture';
import { enableAnnexViaPreload } from './helpers';
import { armDeliveryCommitBarrier, observeDeliveryRequests, restoreDeliveryInstrumentation, type DeliveryBoundary } from './delivery-crash';

let fakesHere: FakeClis | undefined;
let fakesThere: FakeClis | undefined;
let scratch: string | undefined;
let here: LaunchedApp | undefined;
let there: LaunchedApp | undefined;
const profiles: DisposableProfile[] = [];

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try {
    if (app.electronApp.process().exitCode === null && app.electronApp.process().signalCode === null) await restoreDeliveryInstrumentation(app);
  } finally {
    try { await app.electronApp.close(); } catch { /* already gone */ }
    untrackOpenApp(app.electronApp);
  }
}

test.afterEach(async ({}, info) => {
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
  } finally {
    await close(here);
    await close(there);
    here = undefined;
    there = undefined;
    for (const profile of profiles.splice(0)) profile.dispose();
    await fakesHere?.cleanup();
    await fakesThere?.cleanup();
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
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
  const app = await launchApp({
    label,
    args: ['--disable-gpu'],
    userDataFiles: {
      'orchestrator-settings.json': { enabled: [orchestrator], autoDetected: true },
      'chat-runtime-settings.json': { [orchestrator]: { mode: 'chat', ...(orchestrator === 'claude-code' && { driver: 'claude_stream_json' }) } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName, alias: deviceName, icon: 'computer', color: 'indigo', autoReconnect: true },
    },
    env: fakes.env,
  });
  profiles.push(app.profile);
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
  await expect.poll(async () => (await fakesHere!.report('claude').catch(() => undefined))?.env.CLUBHOUSE_AGENT_ID, { timeout: 20_000 }).toBe(senderId);

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
    const report = await fakesThere!.report('claude').catch(() => undefined);
    const prompts = JSON.stringify(report?.unexpected ?? []);
    return prompts.includes('hello from the other desk') && prompts.includes('on Desk') && prompts.includes('[TASK:across1]');
  }, { timeout: 30_000 }).toBe(true);
});

test('a sender crash after a durable200 replays the same identity once, then preserves FIFO and file bytes', async ({}, info) => {
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
  await armDeliveryCommitBarrier(here, firstId, boundaryPath);
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
  expect(pid).toBe(boundary.pid);
  if (!pid) throw new Error('Owned sender PID is unavailable');
  const closed = here.electronApp.waitForEvent('close');
  const child = here.electronApp.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  process.kill(pid, 'SIGKILL');
  await Promise.all([closed, exited]);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
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
  expect(path.dirname(filePath)).toBe(path.join(temp, 'clubhouse-a2a-messages'));
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

test('default native Copilot SDK fixtures accept one remote input and replay a stable delivery without a second input', async ({}, info) => {
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
    const report = await fakes.report('copilot');
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
  const mcp = await connectMcp((await fakesHere.report('copilot')).env);
  const send = (await mcp.toolNames()).find((name) => name.endsWith('__send_message'));
  expect(send).toBeTruthy();
  const args = { message: 'one native SDK fixture input', task_id: 'native-sdk-delivery', idempotency_key: 'native-sdk-delivery' };
  const first = await mcp.call(send!, args);
  expect(first.isError).toBe(false);
  expect(await mcp.call(send!, args)).toEqual(first);
  await expect.poll(async () => (await fakesThere!.report('copilot')).complete).toBe(true);
  const report = await fakesThere.report('copilot');
  expect(report.mismatch).toBeNull();
  expect(report.unexpected).toEqual([]);
  const input = await there.window.evaluate(async (id) => (await window.clubhouse.chat.readTranscript(id))
    .filter((event) => event.type === 'user_message' && event.data.source === 'mcp'), receiverId);
  expect(input).toHaveLength(1);
  const calls = (await fs.promises.readFile(requestsPath, 'utf8')).trim().split('\n');
  expect(calls).toHaveLength(1);
  await info.attach('native-sdk-replay-witness', { body: JSON.stringify({ driver: 'copilot_sdk', runtimeInputs: input.length, actualRequests: calls.length, realLogin: false, modelExecution: false }), contentType: 'application/json' });
});
