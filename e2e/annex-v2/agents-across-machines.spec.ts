/**
 * Agents across machines (#3064, Annex Network stage 7).
 *
 * Two desktops, each with a durable chat agent over the fake Claude CLI (a
 * recorded fixture that opens a session and goes quiet: no model is called,
 * and any prompt lands in the fake's report). The first pairs with the second
 * and the person connects its agent to the other one. Acting as the first
 * agent over its MCP bridge, the test sends a message once the second computer
 * has the connection: it reaches the second computer's agent with the sender's
 * name and machine.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { untrackOpenApp } from '../e2e-cleanup';
import { addProject, assertRunLayout, createDurableAgent } from '../smoke-helpers';
import { isNewLayout } from '../layout';
import { enableAnnexViaPreload } from './helpers';

let fakesHere: FakeClis | undefined;
let fakesThere: FakeClis | undefined;
let scratch: string | undefined;
let here: LaunchedApp | undefined;
let there: LaunchedApp | undefined;

test.setTimeout(300_000);

async function close(app: LaunchedApp | undefined): Promise<void> {
  if (!app) return;
  try { await app.electronApp.close(); } catch { /* already gone */ }
  untrackOpenApp(app.electronApp);
}

test.afterAll(async () => {
  await close(here);
  await close(there);
  await fakesHere?.cleanup();
  await fakesThere?.cleanup();
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
      const result = await rpc('tools/call', { name, arguments: args });
      return { isError: !!result.isError, text: result.content[0].text as string };
    },
  };
}

async function launchDesktop(label: string, fakes: FakeClis, deviceName: string): Promise<LaunchedApp> {
  const app = await launchApp({
    label,
    args: ['--disable-gpu'],
    userDataFiles: {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
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
async function startAgent(app: LaunchedApp, dir: string, name: string): Promise<string> {
  const w = app.window;
  await addProject(app.electronApp, w, dir);
  const id = await createDurableAgent(w, { projectName: path.basename(dir), name, orchestrator: 'claude-code' });
  // Classic opens the agent from its row; the new layout opens a created agent itself.
  if (!(await isNewLayout(w))) await w.locator(`[data-testid="agent-item-${id}"]`).click();
  const chat = w.locator(`[data-testid="chat-view"][data-agent-pane="${id}"][data-view-context="main"]`);
  await expect(chat).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  return id;
}

const fingerprintOf = async (w: Page): Promise<string> =>
  ((await w.evaluate(() => (window as any).clubhouse.annex.getStatus())).fingerprint as string).toLowerCase();

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
