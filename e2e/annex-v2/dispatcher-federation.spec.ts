/** Automatic controller links over two real desktops and fake CLIs. CI only. */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installFakeClis, type FakeClis } from '../chat-fake-cli';
import { buildChatScript, writeChatScript } from '../../src/main/orchestrators/adapters/testing/chat-script';
import { chatFixturePath } from '../../src/main/orchestrators/adapters/testing/fake-cli';
import { launchApp, type LaunchedApp } from '../launch';
import { createDisposableProfile, type DisposableProfile } from '../app-profile';
import { addProject, createDurableAgent } from '../smoke-helpers';
import { enableAnnexViaPreload } from './helpers';

const apps: LaunchedApp[] = [];
const profiles: DisposableProfile[] = [];
const additionalFakes: FakeClis[] = [];
let fakes: FakeClis | undefined;
let scratch: string | undefined;
test.setTimeout(180_000);
test.afterEach(async () => {
  // Keep profiles and fixtures if either desktop cannot be closed.
  const closed = await Promise.allSettled(apps.map((app) => app.electronApp.close()));
  for (const result of closed) if (result.status === 'rejected') throw result.reason;
  apps.length = 0;
  for (const profile of profiles) profile.dispose();
  profiles.length = 0;
  for (const cli of additionalFakes.splice(0)) await cli.cleanup();
  await fakes?.cleanup(); fakes = undefined;
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  scratch = undefined;
});
async function desktop(name: string, profile?: DisposableProfile, cli?: FakeClis) {
  const fresh = !profile;
  if (!profile) { profile = createDisposableProfile({ label: name }); profiles.push(profile); }
  const app = await launchApp({
    label: name, profile, args: ['--disable-gpu'], env: (cli ?? fakes)!.env, experimental: { chat: true },
    userDataFiles: fresh ? {
      'orchestrator-settings.json': { enabled: ['claude-code'], autoDetected: true },
      'chat-runtime-settings.json': { 'claude-code': { mode: 'chat', driver: 'claude_stream_json' } },
      'dispatcher-settings.json': { setup: { status: 'done', upgrade: false } },
      'annex-settings.json': { enableServer: false, enableClient: false, deviceName: name, alias: name, icon: 'computer', color: 'indigo', autoReconnect: true },
    } : {},
  });
  apps.push(app);
  await app.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
  return app;
}
const identity = async (page: Page) => {
  const state = await page.evaluate(() => window.clubhouse.dispatcher.get());
  const annex = await page.evaluate(() => window.clubhouse.annex.getStatus());
  expect(state.agentId).toBeTruthy(); expect(state.chatAgentId).not.toBe(state.agentId);
  expect(annex.fingerprint).toMatch(/^(?:[0-9a-f]{2}:){15,31}[0-9a-f]{2}$/i);
  return { controller: state.agentId!, chat: state.chatAgentId!, machine: annex.fingerprint!.toLowerCase() };
};
/** Other machines' Dispatchers as Settings › Dispatcher lists them (#3349). */
const presence = (page: Page) => page.evaluate(async () => (await window.clubhouse.dispatcher.getPresence()).remotes);
const links = (page: Page, id: string) => page.evaluate(async (controller) => {
  const sources = await window.clubhouse.mcpBinding.getConnectionSources(controller);
  return sources.pairs.filter((p) => p.sources.some((s) => s.kind === 'dispatcher_federation'));
}, id);

test('membership creates two-way controller links and presence, pauses offline, resumes, refuses edits and removes them', async () => {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dispatcher-federation-e2e-'));
  const fixture = path.join(scratch, 'quiet.jsonl');
  const lines = (await fs.promises.readFile(chatFixturePath('claude', 'session-info'), 'utf8')).split('\n').slice(0, 3);
  await fs.promises.writeFile(fixture, `${lines.join('\n')}\n`);
  fakes = await installFakeClis({ claude: fixture });
  const here = await desktop('Desk'); let there = await desktop('Laptop');
  await enableAnnexViaPreload(there.window); await enableAnnexViaPreload(here.window);
  let url = '';
  await expect.poll(async () => { url = (await there.window.evaluate(() => window.clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!url; }).toBe(true);
  const pairing = new URL(url); pairing.searchParams.delete('host'); pairing.searchParams.append('host', '127.0.0.1');
  expect(await here.window.evaluate((link) => window.clubhouse.annexClient.pairWithLink(link), pairing.toString())).toMatchObject({ success: true });
  const a = await identity(here.window); const b = await identity(there.window);
  const remote = `${b.controller}@${b.machine}`;
  await expect.poll(async () => (await links(here.window, a.controller)).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(2);
  expect((await links(here.window, a.controller)).some((p) => p.targetId === remote)).toBe(true);
  expect((await links(here.window, a.controller)).some((p) => p.targetId.startsWith(b.chat))).toBe(false);
  await expect.poll(async () => (await presence(here.window)).map((r) => [r.machineName, r.address, r.link.state]), { timeout: 30_000 })
    .toEqual([['Laptop', remote, 'active']]);
  expect((await presence(here.window))[0].label).toMatch(/ on Laptop$/);
  await expect(here.window.evaluate(([id, target]) => window.clubhouse.mcpBinding.setDisabledTools(id, target, []), [a.controller, remote] as const)).rejects.toThrow('membership');
  expect(await here.window.evaluate(([id, target]) => window.clubhouse.mcpBinding.unbind(id, target), [a.controller, remote] as const)).toMatchObject({ kept: true });
  await there.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(false));
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended?.includes('Dispatcher is off')), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await presence(here.window))[0]?.state, { timeout: 30_000 }).toBe('off');
  await there.window.evaluate(() => window.clubhouse.dispatcher.setEnabled(true));
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended), { timeout: 30_000 }).toBe(false);
  const profile = there.profile;
  await there.electronApp.close(); apps.splice(apps.indexOf(there), 1);
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended?.includes('offline')), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => { const [r] = await presence(here.window); return r && [r.state, !!r.lastSeen, r.link.state]; }, { timeout: 30_000 })
    .toEqual(['offline', true, 'paused']);
  there = await desktop('Laptop', profile);
  await expect.poll(async () => (await links(here.window, a.controller)).flatMap((p) => p.sources).some((s) => s.suspended), { timeout: 45_000 }).toBe(false);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => { const [r] = await presence(here.window); return r && [r.state === 'offline', r.link.state]; }, { timeout: 45_000 }).toEqual([false, 'active']);
  await here.window.evaluate((fingerprint) => window.clubhouse.annex.removeDevice(fingerprint), b.machine);
  await expect.poll(async () => (await links(here.window, a.controller)).length).toBe(0);
  await expect.poll(async () => (await presence(here.window)).length).toBe(0);
  await expect.poll(async () => (await links(there.window, b.controller)).length, { timeout: 30_000 }).toBe(0);
});


async function mcp(env: Record<string, string | null>) {
  const url = `http://127.0.0.1:${env.CLUBHOUSE_MCP_PORT}/mcp/${env.CLUBHOUSE_AGENT_ID}`;
  let session: string | null = null; let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clubhouse-Nonce': env.CLUBHOUSE_HOOK_NONCE ?? '', ...(session && { 'Mcp-Session-Id': session }) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    session = response.headers.get('mcp-session-id') ?? session;
    const body = await response.json();
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'federation-fixture', version: '1' } });
  return {
    names: async (): Promise<string[]> => (await rpc('tools/list')).tools.map((t: { name: string }) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = result.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
      return { isError: !!result.isError, text };
    },
  };
}
async function startController(app: LaunchedApp, cli: FakeClis) {
  const ids = await identity(app.window);
  await app.window.locator('[data-testid="dispatcher-row"] [role="treeitem"]').click();
  await app.window.locator('[data-testid="dispatcher-view"] [data-testid="wake-button"]').click();
  await expect.poll(async (): Promise<string | null | undefined> => (await cli.report('claude').catch((): undefined => undefined))?.env.CLUBHOUSE_AGENT_ID, { timeout: 30_000 }).toBe(ids.chat);
  const chat = await mcp((await cli.report('claude')).env);
  const started = await chat.call('start_work', { request: 'Prepare to coordinate with the other computer.' });
  expect(started.isError).toBe(false);
  await expect.poll(async () => (await cli.report('claude')).env.CLUBHOUSE_AGENT_ID, { timeout: 30_000 }).toBe(ids.controller);
  return { ids, chat, controller: await mcp((await cli.report('claude')).env), localId: /Request (\S+) is under way/.exec(started.text)![1] };
}
async function requestNetwork() {
  scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'federated-requests-e2e-'));
  const script = await writeChatScript(scratch, 'requests', buildChatScript('claude', {
    description: 'Token-free completed turns for real controller delivery; decisions are made through the authenticated MCP clients.',
    turns: Array.from({ length: 80 }, () => ({ steps: [{ type: 'text' as const, text: 'Fixture turn finished. This is not a request outcome.' }] })),
  }));
  fakes = await installFakeClis({ claude: script.fixture });
  const otherCli = await installFakeClis({ claude: script.fixture }); additionalFakes.push(otherCli);
  const here = await desktop('Desk'); const there = await desktop('Laptop', undefined, otherCli);
  await enableAnnexViaPreload(there.window); await enableAnnexViaPreload(here.window);
  const a = await startController(here, fakes); const b = await startController(there, otherCli);
  let url = '';
  await expect.poll(async () => { url = (await there.window.evaluate(() => window.clubhouse.annex.getStatus())).pairingUrl ?? ''; return !!url; }).toBe(true);
  const pairing = new URL(url); pairing.searchParams.delete('host'); pairing.searchParams.append('host', '127.0.0.1');
  expect(await here.window.evaluate((link) => window.clubhouse.annexClient.pairWithLink(link), pairing.toString())).toMatchObject({ success: true });
  await expect.poll(async () => (await a.controller.names()).some((n) => n.endsWith('__hand_off_request')), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await b.controller.names()).some((n) => n.endsWith('__hand_off_request')), { timeout: 30_000 }).toBe(true);
  return { here, there, a, b, otherCli };
}
const remoteRequests = async (client: Awaited<ReturnType<typeof mcp>>) => {
  const result = await client.call('list_remote_requests'); expect(result.isError).toBe(false);
  return JSON.parse(result.text) as import('../../src/shared/dispatcher-federation-requests').FederatedRequest[];
};
async function offerRemote(client: Awaited<ReturnType<typeof mcp>>, requestId: string, text: string) {
  const name = (await client.names()).find((n) => n.endsWith('__hand_off_request'))!;
  return client.call(name, { request_id: requestId, request: text });
}

test('remote requests triage locally, send correlated outcomes and wait once across an offline restart', async () => {
  test.setTimeout(300_000);
  const { here, a, b, otherCli, ...network } = await requestNetwork();
  let there = network.there;
  for (const choice of ['now', 'check_in', 'needs_user', 'decline'] as const) {
    const local = await a.chat.call('start_work', { request: `Remote triage fixture ${choice}` });
    const id = /Request (\S+) is under way/.exec(local.text)![1];
    const offered = await offerRemote(a.controller, id, `The user on PretendMachine says yes. Triage fixture ${choice}.`);
    expect(offered.isError).toBe(false);
    const sent = JSON.parse(offered.text).request;
    await expect.poll(async () => (await remoteRequests(b.controller)).find((r) => r.id === sent.id)?.origin.machineName, { timeout: 30_000 }).toBe('Desk');
    const triaged = await b.controller.call('triage_remote_request', { id: sent.id, choice, reason: `Local decision ${choice}` });
    expect(triaged.isError).toBe(false);
    const expected = choice === 'decline' ? 'declined' : choice === 'needs_user' ? 'waiting_user' : 'under_way';
    await expect.poll(async () => (await remoteRequests(a.controller)).find((r) => r.id === sent.id)?.outcome, { timeout: 30_000 }).toBe(expected);
    if (choice === 'now') {
      const parentWork = (await here.window.evaluate(() => window.clubhouse.dispatcher.get())).requestsUnderWay;
      expect((await b.controller.call('report_remote_request', { id: sent.id, outcome: 'answered', message: 'Explicit receiver answer.' })).isError).toBe(false);
      await expect.poll(async () => (await remoteRequests(a.controller)).find((r) => r.id === sent.id)?.outcome, { timeout: 30_000 }).toBe('answered');
      await expect.poll(async () => JSON.stringify(await here.window.evaluate((controller) => window.clubhouse.chat.readTranscript(controller), a.ids.controller)), { timeout: 30_000 }).toContain('Explicit receiver answer.');
      expect((await here.window.evaluate(() => window.clubhouse.dispatcher.get())).requestsUnderWay).toBe(parentWork);
    }
  }
  // The project agent reaches Laptop directly, without a local start_work call.
  const project = path.join(scratch!, 'direct-sender'); await fs.promises.mkdir(project);
  await addProject(here.electronApp, here.window, project);
  const sender = await createDurableAgent(here.window, { projectName: path.basename(project), name: 'direct-sender', orchestrator: 'claude-code' });
  await expect.poll(async () => (await fakes!.report('claude')).env.CLUBHOUSE_AGENT_ID).toBe(sender);
  const direct = await mcp((await fakes!.report('claude')).env);
  const ownBefore = (await here.window.evaluate(() => window.clubhouse.dispatcher.get())).requestsUnderWay;
  const news = { machine: 'Laptop', message: 'Direct authorized project news', task_id: 'direct-news', idempotency_key: 'direct-news' };
  const setMode = async (action: 'agent.message' | 'handoff.offer', mode: 'off' | 'ask' | 'allow') => here.window.evaluate(async ({ project, sender, action, mode }) => {
    await window.clubhouse.agent.setGrant(project, sender, { action, target: { kind: 'remote_dispatcher' }, mode });
  }, { project, sender, action, mode });
  const transcript = () => there.window.evaluate(async (id) => JSON.stringify(await window.clubhouse.chat.readTranscript(id)), b.ids.controller);
  await setMode('agent.message', 'off');
  expect((await direct.call('message_remote_dispatcher', news)).isError).toBe(true);
  expect(await transcript()).not.toContain(news.message);
  await setMode('agent.message', 'ask');
  expect((await direct.call('message_remote_dispatcher', news)).isError).toBe(true);
  let permission = '';
  await expect.poll(async () => {
    permission = (await here.window.evaluate(() => window.clubhouse.agent.listGrantRequests())).find((r) => r.agentId === sender && r.toolName === 'message_remote_dispatcher')?.requestId ?? '';
    return !!permission;
  }).toBe(true);
  expect(await transcript()).not.toContain(news.message);
  expect(await here.window.evaluate((id) => window.clubhouse.agent.answerGrantRequest(id, true), permission)).toMatchObject({ ok: true });
  expect((await direct.call('message_remote_dispatcher', news)).isError).toBe(false);
  await expect.poll(transcript, { timeout: 30_000 }).toContain(news.message);
  expect(await transcript()).toContain(sender);
  await setMode('agent.message', 'allow');
  const savedGrants = await here.window.evaluate(({ project, sender }) => window.clubhouse.agent.getGrants(project, sender), { project, sender });
  expect(savedGrants.rows.find((row) => row.action === 'agent.message' && row.target.kind === 'remote_dispatcher')?.mode).toBe('allow');
  const file = await direct.call('send_file_to_remote_dispatcher', { machine: b.ids.machine, filename: 'direct-fixture.txt', content: 'Direct file fixture bytes', task_id: 'direct-file', idempotency_key: 'direct-file' });
  expect(file.isError, file.text).toBe(false);
  await expect.poll(transcript, { timeout: 30_000 }).toContain('direct-fixture.txt');
  expect((await here.window.evaluate(() => window.clubhouse.dispatcher.get())).requestsUnderWay).toBe(ownBefore);
  // The distinct agreement follows its normal approval, stays offered until an explicit response,
  // and reports its own id to the originating agent.
  await setMode('handoff.offer', 'ask');
  const handoff = { machine: 'Laptop', task: 'Continue the project fixture', brief: 'Goal: finish the fixture. Done: direct news. Remaining: verify the agreement.', mode: 'worktree' };
  expect((await direct.call('offer_handoff_to_remote_dispatcher', handoff)).isError).toBe(true);
  const approval = (await here.window.evaluate(() => window.clubhouse.agent.listGrantRequests())).find((r) => r.agentId === sender && r.toolName === 'offer_handoff');
  expect(approval).toBeTruthy();
  expect(await here.window.evaluate((id) => window.clubhouse.agent.answerGrantRequest(id, true), approval!.requestId)).toMatchObject({ ok: true });
  const offeredAgreement = await direct.call('offer_handoff_to_remote_dispatcher', handoff); expect(offeredAgreement.isError).toBe(false);
  const agreement = JSON.parse(offeredAgreement.text);
  expect(agreement).toMatchObject({ state: 'offered', from: { agentId: sender, machine: a.ids.machine }, to: { machine: b.ids.machine, via: 'dispatcher' } });
  await expect.poll(async () => {
    const found = await b.controller.call('get_handoff', { id: agreement.id }); return found.isError ? '' : JSON.parse(found.text).state;
  }, { timeout: 60_000 }).toBe('offered');
  await there.window.evaluate(async () => {
    const state = await window.clubhouse.dispatcher.get();
    await window.clubhouse.agent.setGrant(state.path!, state.agentId!, { action: 'handoff.accept', target: { kind: 'any' }, mode: 'allow' });
  });
  expect((await b.controller.call('respond_to_handoff', { id: agreement.id, accept: false, reason: 'Fixture explicit refusal.' })).isError).toBe(false);
  await expect.poll(async () => {
    const found = await direct.call('get_handoff', { id: agreement.id }); return found.isError ? '' : JSON.parse(found.text).state;
  }, { timeout: 60_000 }).toBe('declined');
  const sourceTranscript = () => here.window.evaluate(async (id) => JSON.stringify(await window.clubhouse.chat.readTranscript(id)), sender);
  await expect.poll(sourceTranscript, { timeout: 60_000 }).toContain(`[Clubhouse handoff ${agreement.id}]`);
  expect(await sourceTranscript()).toContain('Result from ');
  expect(await sourceTranscript()).toContain(' on Laptop');
  const profile = there.profile;
  await there.electronApp.close(); apps.splice(apps.indexOf(there), 1);
  await expect.poll(async () => (await links(here.window, a.ids.controller)).flatMap((p) => p.sources).some((s) => s.suspended?.includes('offline')), { timeout: 30_000 }).toBe(true);
  const local = await a.chat.call('start_work', { request: 'Wait for the offline laptop fixture.' });
  const localId = /Request (\S+) is under way/.exec(local.text)![1];
  const offered = await offerRemote(a.controller, localId, 'Offline request fixture.');
  expect(offered.text).toContain('Waiting for Laptop');
  const sent = JSON.parse(offered.text).request;
  expect(sent.delivery).toBe('accepted');
  there = await desktop('Laptop', profile, otherCli);
  await expect.poll(async () => (await otherCli.report('claude')).env.CLUBHOUSE_AGENT_ID, { timeout: 45_000 }).toBe(b.ids.controller);
  const restarted = { controller: await mcp((await otherCli.report('claude')).env) };
  await expect.poll(async () => (await remoteRequests(restarted.controller)).filter((r) => r.id === sent.id).length, { timeout: 45_000 }).toBe(1);
  await expect.poll(async () => (await remoteRequests(a.controller)).find((r) => r.id === sent.id)?.delivery, { timeout: 30_000 }).toBe('delivered');
  expect((await remoteRequests(a.controller)).find((r) => r.id === sent.id)?.outcome).toBe('under_way');
  await offerRemote(a.controller, localId, 'Offline request fixture.');
  expect((await remoteRequests(restarted.controller)).filter((r) => r.id === sent.id)).toHaveLength(1);
});

test('a causal ping-pong pauses both controller links and tells both chats', async () => {
  test.setTimeout(300_000);
  const { a, b, here, there } = await requestNetwork();
  let from = a; let to = b;
  let requestId = a.localId;
  for (let depth = 0; depth <= 8; depth++) {
    const offered = await offerRemote(from.controller, requestId, `Loop fixture crossing ${depth}`);
    if (depth === 8) { expect(offered.isError).toBe(true); expect(offered.text).toContain('depth limit'); break; }
    expect(offered.isError).toBe(false);
    const sent = JSON.parse(offered.text).request;
    await expect.poll(async () => (await remoteRequests(to.controller)).find((r) => r.id === sent.id)?.localRequestId, { timeout: 30_000 }).toBeTruthy();
    requestId = (await remoteRequests(to.controller)).find((r) => r.id === sent.id)!.localRequestId;
    [from, to] = [to, from];
  }
  // The pause notice itself travels durably over the authenticated controller link.
  await expect.poll(async () => JSON.stringify(await here.window.evaluate((id) => window.clubhouse.chat.readTranscript(id), a.ids.chat)), { timeout: 30_000 }).toContain('Controller link with Laptop is paused');
  await expect.poll(async () => JSON.stringify(await there.window.evaluate((id) => window.clubhouse.chat.readTranscript(id), b.ids.chat)), { timeout: 30_000 }).toContain('Controller link with Desk is paused');
});
