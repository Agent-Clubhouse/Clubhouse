import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tel } from '../telemetry/facade';

const state = vi.hoisted(() => ({ base: '', pairing: 'self-epoch', peerPairing: 'peer-epoch', thirdRole: 'satellite' as 'member' | 'satellite' }));
const SELF = Array(16).fill('aa').join(':');
const OTHER = Array(16).fill('bb').join(':');
const THIRD = Array(16).fill('cc').join(':');
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: SELF.toUpperCase() }) }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: state.pairing }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [
  { fingerprint: OTHER.toUpperCase(), alias: 'Studio', role: 'member', kind: 'desktop', pairingId: state.peerPairing },
  // A one-to-one pairing: not in the network.
  { fingerprint: THIRD.toUpperCase(), alias: 'Old Mac', role: state.thirdRole, kind: 'desktop' },
] }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-agent-calls-'));

import {
  AGENT_CALL_VERSION, LOOP_LIMIT, RATE_LIMIT, currentRemoteCaller, forwardAgentCall, receiveAgentCall, receiveDirections,
  remoteAgentName, startAgentCalls, _clearOutboxForTesting, syncDirectionsWith, waitingFor, flushOutbox, isNetworkComputer, getDelivery, type AgentCallTransport, type RemoteCaller,
} from './annex-agent-calls';
import { createAnnexDeliveryStore, DELIVERY_MAX_AGE_MS } from './annex-delivery-store';
import {
  getConnectionDirection, listAllConnectionDirections, putConnectionDirection, removeConnectionDirections, setConnectionLink, setConnectionTools, updateAgentNetworkLinks,
} from './connection-grants-store';
import type { McpToolResult } from './clubhouse-mcp/types';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const textOf = (r: McpToolResult) => (r.content[0] as { text: string }).text;

let connected = true;
let posts: Array<{ machine: string; path: string; body: Record<string, unknown> }> = [];
const delivered = (body: Record<string, unknown>, message = 'done there') => ({
  status: 200, body: { result: ok(message), delivery: { callId: body.callId, state: 'delivered', receiptAt: new Date().toISOString() } },
});
let respond: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } = (_path, body) => delivered(body);
let connectedListener: ((machine: string) => void) | null = null;
const seen: Array<{ tool: string; targetId: string; callerId: string; args: Record<string, unknown>; caller?: RemoteCaller }> = [];

const transport: AgentCallTransport = {
  connected: () => connected,
  supportsDurableDelivery: async () => true,
  post: async (machine, urlPath, body) => { posts.push({ machine, path: urlPath, body }); return respond(urlPath, body); },
  machineName: () => 'Studio',
  onConnected: (listener) => { connectedListener = listener; return () => { connectedListener = null; }; },
};

let stop: () => void = () => {};
let now = 1_000_000;

function call(overrides: Record<string, unknown> = {}) {
  return {
    v: AGENT_CALL_VERSION, callId: `c-${Math.random()}`, from: { agentId: 'sender', name: 'Scout', projectName: 'Atlas' },
    to: 'receiver', tool: 'send_message', args: { message: 'hi' }, ...overrides,
  };
}

const inbound = { from: { agentId: 'sender', machineId: OTHER }, to: { agentId: 'receiver' } };

beforeEach(async () => {
  for (const id of ['sender', 'receiver', 'here', 'there']) await removeConnectionDirections(id);
  await _clearOutboxForTesting();
  connected = true;
  state.pairing = 'self-epoch';
  state.peerPairing = 'peer-epoch';
  state.thirdRole = 'satellite';
  posts = [];
  seen.length = 0;
  respond = (_path, body) => delivered(body);
  now += 3_600_000;
  stop = startAgentCalls({
    transport,
    authorizeQueuedCall: async () => ({ allowed: true }),
    runTool: async (tool, targetId, callerId, args) => { seen.push({ tool, targetId, callerId, args, caller: currentRemoteCaller() }); return ok('ran here'); },
    describeLocalAgent: async (id) => (id === 'receiver' ? { name: 'Builder' } : id === 'here' ? { name: 'Helper', projectName: 'Atlas' } : undefined),
  });
});
afterEach(() => { stop(); vi.restoreAllMocks(); });

function nextRetry(ms = 3_600_000): void {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);
}

describe('receiving a call from another machine (#3064)', () => {
  it('runs nothing without the person\'s link for that direction, and says the same whether or not the agent exists', async () => {
    const refused = await receiveAgentCall(OTHER, call(), now);
    expect(refused).toMatchObject({ status: 403, error: 'not_connected' });
    // Tools alone (no link) aren't a connection.
    await setConnectionTools(inbound.from, inbound.to, []);
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ status: 403, error: 'not_connected' });
    expect(await receiveAgentCall(OTHER, call({ to: 'nobody' }), now)).toMatchObject({ status: 403, error: 'not_connected' });
    expect(seen).toHaveLength(0);
  });

  it('runs a call the link allows, as the sender on its machine, and refuses a tool turned off on it', async () => {
    await setConnectionLink(inbound.from, inbound.to, true, ['clear_agent']);
    const result = await receiveAgentCall(OTHER, call(), now);
    expect(result).toMatchObject({ result: ok('ran here'), delivery: { state: 'delivered' } });
    expect(seen[0]).toMatchObject({ tool: 'send_message', targetId: 'receiver', callerId: `sender@${OTHER}`, args: { message: 'hi' } });
    expect(seen[0].caller).toMatchObject({ name: 'Scout', projectName: 'Atlas', machineName: 'Studio', targetName: 'Builder', machineId: OTHER, agentId: 'sender' });
    expect(await receiveAgentCall(OTHER, call({ tool: 'clear_agent' }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('checks calls against an agent-created network source and its disabled tools', async () => {
    const at = new Date(now).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{
      from: { agentId: 'sender', machine: OTHER }, to: { agentId: 'receiver', machine: SELF },
      disabledTools: ['clear_agent'], link: true, userLink: false,
      agentLinks: [{ agentId: 'maker', machineId: OTHER, createdAt: at }], updatedAt: at,
    }] });
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, call({ tool: 'clear_agent' }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('wakes an agent here when the link allows it, and not when wake is switched off on it (#3056: message, wake and read)', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: { message: 'start on it' } }), now)).toMatchObject({ result: ok('ran here') });
    expect(seen.at(-1)).toMatchObject({ tool: 'wake_agent', targetId: 'receiver', callerId: `sender@${OTHER}` });
    expect(seen.at(-1)!.caller).toMatchObject({ name: 'Scout', machineName: 'Studio' });
    await setConnectionTools(inbound.from, inbound.to, ['wake_agent']);
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: {} }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('counts wakes with messages for the loop limit', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let t = now;
    for (let i = 0; i < LOOP_LIMIT.messages; i++) {
      expect(await receiveAgentCall(OTHER, call({ tool: i % 2 ? 'wake_agent' : 'send_message', args: i % 2 ? {} : { message: 'x' } }), t)).toHaveProperty('result');
      t += Math.floor(RATE_LIMIT.windowMs / RATE_LIMIT.calls) + 1;
    }
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: {} }), t)).toMatchObject({ status: 429, error: 'loop_limited' });
  });

  it('takes the sender\'s machine from the connection, not from the call', async () => {
    await setConnectionLink({ agentId: 'sender', machineId: THIRD }, inbound.to, true);
    // A machine can't speak for an agent on a third machine.
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ status: 403, error: 'not_connected' });
  });

  it('refuses tools no connection carries, an agent on another machine, and a call it can\'t read', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ tool: 'change_provider' }), now)).toMatchObject({ status: 403, error: 'tool_not_allowed' });
    expect(await receiveAgentCall(OTHER, call({ to: `receiver@${THIRD}` }), now)).toMatchObject({ status: 404, error: 'wrong_machine' });
    expect(await receiveAgentCall(OTHER, call({ to: `receiver@${SELF}` }), now)).toMatchObject({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, call({ from: { agentId: 'x@y', name: 'n' } }), now)).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, { ...call(), v: 2 }, now)).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, null, now)).toMatchObject({ status: 400 });
  });

  it('limits calls per link, and messages back and forth between one pair', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    for (let i = 0; i < RATE_LIMIT.calls; i++) expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now)).toHaveProperty('result');
    expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now)).toMatchObject({ status: 429, error: 'rate_limited' });
    // A minute later the link has room again.
    expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now + RATE_LIMIT.windowMs)).toHaveProperty('result');

    let t = now + 2 * RATE_LIMIT.windowMs;
    let sent = 0;
    while (sent < LOOP_LIMIT.messages) {
      expect(await receiveAgentCall(OTHER, call(), t)).toHaveProperty('result');
      sent++;
      // Spaced out so only the loop limit applies.
      t += Math.floor(RATE_LIMIT.windowMs / RATE_LIMIT.calls) + 1;
    }
    expect(await receiveAgentCall(OTHER, call(), t)).toMatchObject({ status: 429, error: 'loop_limited' });
  });
});

describe('receiving: repeats, and copies from another machine\'s clock', () => {
  it('runs a call id once: a retry after a lost answer gets the first answer', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const once = call({ callId: 'same' });
    expect(await receiveAgentCall(OTHER, once, now)).toMatchObject({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, once, now)).toMatchObject({ result: ok('ran here') });
    expect(seen).toHaveLength(1);
  });

  it('takes a copy dated far ahead as made now, and a link only for an agent here that exists', async () => {
    const ahead = new Date(now + 24 * 3_600_000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: ahead },
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'nobody', machine: SELF }, disabledTools: [], link: true, updatedAt: ahead },
    ] }, now);
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.updatedAt).toBe(new Date(now).toISOString());
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'nobody' })).toBeUndefined();
    // So an edit here a moment later still wins over it.
    expect(Date.parse(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })!.updatedAt)).toBeLessThan(now + 1000);
  });
});

describe('only computers in the network (D238)', () => {
  it('knows a network computer from a one-to-one pairing or an unknown machine', () => {
    expect(isNetworkComputer(OTHER)).toBe(true);
    expect(isNetworkComputer(THIRD)).toBe(false);
    expect(isNetworkComputer(Array(16).fill('dd').join(':'))).toBe(false);
  });

  it('sends nothing to a machine paired one-to-one', async () => {
    const result = await forwardAgentCall('here', `there@${THIRD}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not in this computer's Annex Network");
    expect(posts).toHaveLength(0);
  });
});

describe('sending a call to another machine', () => {
  it.each(['Dispatcher', 'Rosie'])('serializes physical Dispatcher sender roles for chat named %s without expanding local endpoint eligibility', async (chatName) => {
    stop();
    const nameOfLocalSender = vi.fn((id: string) => id === 'dispatcher-work' ? 'Dispatcher controller' : id === 'dispatcher-chat' ? chatName : undefined);
    stop = startAgentCalls({
      transport,
      runTool: async () => { throw new Error('No inbound call is eligible'); },
      describeLocalAgent: async (id) => id === 'here' ? { name: 'Helper', projectName: 'Atlas' } : undefined,
      nameOfLocalSender,
    });
    const args = { agentId: 'spoofed', name: 'Not the sender' };
    for (const id of ['dispatcher-work', 'dispatcher-chat', 'here', 'unknown']) {
      expect(await forwardAgentCall(id, `there@${OTHER}`, 'Far agent', 'get_status', args)).toEqual(ok('done there'));
    }
    expect(posts.map((p) => p.body.from)).toEqual([
      { agentId: 'dispatcher-work', name: 'Dispatcher controller' },
      { agentId: 'dispatcher-chat', name: chatName },
      { agentId: 'here', name: 'Helper', projectName: 'Atlas' },
      { agentId: 'unknown', name: 'unknown' },
    ]);
    for (const post of posts) {
      expect(post).toMatchObject({ machine: OTHER, path: '/api/v1/network/agent-call', body: { to: 'there', tool: 'get_status', args } });
    }

    nameOfLocalSender.mockClear();
    const at = new Date(now).toISOString();
    expect(await receiveDirections(OTHER, { v: 1, directions: ['dispatcher-work', 'dispatcher-chat', 'unknown'].map((id) => ({
      from: { agentId: 'there', machine: OTHER }, to: { agentId: id, machine: SELF },
      disabledTools: [] as const, link: true, updatedAt: at,
    })) }, now)).toEqual({ applied: 0 });
    for (const id of ['dispatcher-work', 'dispatcher-chat', 'unknown']) {
      expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: id })).toBeUndefined();
      expect(await receiveAgentCall(OTHER, call({ to: id }), now)).toMatchObject({ status: 403, error: 'not_connected' });
    }
    expect(nameOfLocalSender).not.toHaveBeenCalled();
  });

  it('posts it with the sender\'s name and project, and returns the other machine\'s answer', async () => {
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result).toEqual(ok('done there'));
    expect(posts[0]).toMatchObject({ machine: OTHER, path: '/api/v1/network/agent-call' });
    expect(posts[0].body).toMatchObject({ v: 1, to: 'there', tool: 'send_message', args: { message: 'hello' }, from: { agentId: 'here', name: 'Helper', projectName: 'Atlas' } });
  });

  it('says the other machine\'s refusal in its words', async () => {
    respond = () => ({ status: 403, body: { error: 'tool_denied', message: 'send_message is turned off on this connection.' } });
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('send_message is turned off on this connection.');
  });

  it('while the machine is offline: a message waits and goes, in order, when it\'s back; a read says offline; others are refused', async () => {
    connected = false;
    const first = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one', task_id: 't1' });
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain('Studio, which is offline');
    expect(textOf(first)).toContain('task_id=t1');
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_file', { content: 'two' });
    expect(JSON.parse(textOf(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'get_status', {})))).toMatchObject({ status: 'offline' });
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'clear_agent', {})).isError).toBe(true);
    // A wake whose moment has passed isn't kept for later.
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'wake_agent', {})).isError).toBe(true);
    expect(posts).toHaveLength(0);
    expect(waitingFor(OTHER).map((i) => i.body.tool)).toEqual(['send_message', 'send_file']);

    connected = true;
    connectedListener!(OTHER);
    await vi.waitFor(() => expect(waitingFor(OTHER)).toHaveLength(0));
    const calls = posts.filter((p) => p.path === '/api/v1/network/agent-call');
    expect(calls.map((p) => p.body.tool)).toEqual(['send_message', 'send_file']);
  });

  it('keeps what waited when the other machine is busy or at its limit, and drops one it refuses', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'a' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'b' });
    connected = true;
    respond = () => ({ status: 429, body: { error: 'rate_limited' } });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    respond = () => ({ status: 404, body: { error: 'unavailable' } });
    nextRetry(61_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Not connected there yet, for a message just queued: the link may still be on its way.
    respond = () => ({ status: 403, body: { error: 'not_connected' } });
    nextRetry(121_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Any other refusal is final: the tool is off there.
    respond = () => ({ status: 403, body: { error: 'tool_denied' } });
    nextRetry(241_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
  });

  it('queues a new message behind ones still waiting, even once the machine is back', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'first' });
    connected = true;
    respond = () => ({ status: 503, body: {} });
    const second = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'second' });
    expect(textOf(second)).toContain('behind messages already on their way');
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(waitingFor(OTHER).map((i) => i.body.args.message)).toEqual(['first', 'second']);
    respond = (_path, body) => delivered(body, 'ok');
    nextRetry();
    await flushOutbox(OTHER);
    expect(posts.filter((p) => p.path === '/api/v1/network/agent-call').slice(-2).map((p) => (p.body.args as { message: string }).message)).toEqual(['first', 'second']);
  });

  it('counts messages to one agent on this side too, so the limit holds both ways', async () => {
    let t = now;
    for (let i = 0; i < LOOP_LIMIT.messages; i++) {
      expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: `m${i}` }, t)).isError).toBeFalsy();
      t += 1000;
    }
    const over = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one more' }, t);
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain('paused');
  });

  it('keeps what waited when the machine fails to answer, for the next connect', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'later' });
    connected = true;
    respond = () => ({ status: 503, body: {} });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(1);
    respond = (_path, body) => delivered(body, 'ok');
    nextRetry();
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
  });
});

describe('durable receipts and crash boundaries (#3334)', () => {
  function restart(options: Partial<Parameters<typeof startAgentCalls>[0]> = {}): void {
    stop();
    stop = startAgentCalls({
      transport, describeLocalAgent: async () => ({ name: 'Builder' }),
      runTool: async (tool, targetId, callerId, args) => { seen.push({ tool, targetId, callerId, args }); return ok('ran here'); },
      authorizeQueuedCall: async () => ({ allowed: true }),
      deliveryStore: createAnnexDeliveryStore(),
      ...options,
    });
  }

  it('accepts no queued or receiving effect from a raw-null store until explicit repair and restart', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const filename = 'corrupt-recovery.json';
    const filePath = path.join(state.base, filename);
    fs.writeFileSync(filePath, 'null');
    restart({ deliveryStore: createAnnexDeliveryStore(filename) });
    const body = call({ callId: 'after-explicit-recovery' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ status: 503, error: 'delivery_store_unavailable' });
    await expect(forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'not queued into corrupt state' })).rejects.toMatchObject({ code: 'delivery_store_unreadable' });
    expect(seen).toHaveLength(0);
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('null');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, outbox: [], inbox: [], deliveries: [] }));
    restart({ deliveryStore: createAnnexDeliveryStore(filename) });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'delivered' } });
    expect(seen).toHaveLength(1);
    restart();
  });

  it('replays a durable receiver answer after reload without another execution, and rejects changed content', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const body = call({ callId: 'restart-answer' });
    const first = await receiveAgentCall(OTHER, body, now);
    restart();
    expect(await receiveAgentCall(OTHER, body, now)).toEqual(first);
    expect(seen).toHaveLength(1);
    expect(await receiveAgentCall(OTHER, { ...body, args: { message: 'different' } }, now)).toMatchObject({ error: 'idempotency_conflict' });
    await setConnectionTools(inbound.from, inbound.to, ['send_message']);
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ error: 'tool_denied' });
  });

  it('quarantines a receiver crash after the side effect but before receipt persistence', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const store = createAnnexDeliveryStore();
    let writes = 0;
    restart({ deliveryStore: {
      ...store,
      update: async (change, at) => {
        if (++writes === 2) throw new Error('simulated receipt write crash');
        return store.update(change, at);
      },
    } });
    const body = call({ callId: 'crash-after-run' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    restart();
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate', reason: 'receiver_interrupted' } });
    expect(seen).toHaveLength(1);
  });

  it('persists safe busy/starting retries separately from accepted input and does not cache a failed promise', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let busy = true;
    const run = vi.fn(async () => busy
      ? { ...ok('starting'), isError: true, annexDelivery: { state: 'retry_later' as const, reason: 'starting' } }
      : ok('accepted by runtime'));
    restart({ runTool: run });
    const body = call({ callId: 'busy-then-ready' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'retry_later', reason: 'starting' } });
    restart({ runTool: run });
    busy = false;
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'delivered' } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not automatically repeat an unclassified throw that may follow a partial side effect', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const run = vi.fn(async () => { throw new Error('lost SDK answer'); });
    restart({ runTool: run });
    const body = call({ callId: 'ambiguous-sdk-answer' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rechecks receiver permission after an awaited lookup and before execution', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    restart({ describeLocalAgent: async () => {
      await setConnectionTools(inbound.from, inbound.to, ['send_message']);
      return { name: 'Builder' };
    } });
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ delivery: { state: 'refused', reason: 'authorization_revoked' } });
    expect(seen).toHaveLength(0);
  });

  it('dedupes direct sends with a stable caller key after restart and binds that key to the content', async () => {
    const args = { message: 'once', idempotency_key: 'job-1' };
    const first = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    const id = posts.find((p) => p.path.endsWith('agent-call'))!.body.callId as string;
    restart();
    expect(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args)).toEqual(first);
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
    expect(textOf(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { ...args, message: 'changed' }))).toContain('idempotency_conflict');
    expect(getDelivery('here', id)).toMatchObject({ state: 'delivered', attempts: 1 });
    expect(getDelivery('someone-else', id)).toBeUndefined();
  });

  it('resends the same id after sender crashes after 200 but before removal, preserving order', async () => {
    connected = false;
    const store = createAnnexDeliveryStore();
    let crash = false;
    restart({ deliveryStore: {
      ...store,
      update: async (change, at) => {
        if (crash) { crash = false; throw new Error('sender crashed before removal'); }
        return store.update(change, at);
      },
    } });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'first' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'second' });
    const firstId = waitingFor(OTHER)[0].id;
    const receiver = new Map<string, ReturnType<typeof delivered>>();
    let executions = 0;
    respond = (urlPath, body) => {
      if (!urlPath.endsWith('agent-call')) return { status: 200, body: { directions: [] } };
      if (!receiver.has(body.callId as string)) { receiver.set(body.callId as string, delivered(body)); executions++; }
      crash = body.callId === firstId;
      return receiver.get(body.callId as string)!;
    };
    connected = true;
    await expect(flushOutbox(OTHER)).rejects.toThrow('sender crashed before removal');
    expect(waitingFor(OTHER).map((i) => i.id)[0]).toBe(firstId);
    connected = false;
    restart();
    connected = true;
    nextRetry();
    // Let this receiver return the retained receipt without another execution.
    respond = (urlPath, body) => {
      if (!urlPath.endsWith('agent-call')) return { status: 200, body: { directions: [] } };
      if (!receiver.has(body.callId as string)) { receiver.set(body.callId as string, delivered(body)); executions++; }
      return receiver.get(body.callId as string)!;
    };
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(posts.filter((p) => p.path.endsWith('agent-call')).map((p) => (p.body.args as { message: string }).message)).toEqual(['first', 'first', 'second']);
    expect(executions).toBe(2);
  });

  it('retains an explicit safe-to-retry 200 tool error and honors persisted backoff', async () => {
    respond = (_path, body) => ({ status: 200, body: { result: { ...ok('busy'), isError: true }, delivery: { callId: body.callId, state: 'retry_later', reason: 'busy' } } });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'wait' });
    const id = waitingFor(OTHER)[0].id;
    expect(getDelivery('here', id)).toMatchObject({ state: 'retry_later', attempts: 1 });
    const count = posts.length;
    connected = false;
    restart();
    connected = true;
    await flushOutbox(OTHER);
    expect(posts).toHaveLength(count);
    nextRetry();
    respond = (_path, body) => delivered(body);
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  it('never retries a legacy ACK whose receiver cannot prove a durable receipt', async () => {
    respond = () => ({ status: 200, body: { result: ok('legacy accepted input') } });
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'do not repeat', idempotency_key: 'old-peer' });
    expect(result.isError).toBe(true);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(textOf(result)).toContain('automatic redelivery is disabled');
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'do not repeat', idempotency_key: 'old-peer' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('refuses old peers before input and waits safely when capability negotiation is unavailable', async () => {
    const report = vi.spyOn(tel, 'exception').mockImplementation(() => {});
    const support = vi.spyOn(transport, 'supportsDurableDelivery').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false);
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'requires durable receiver' });
    const id = waitingFor(OTHER)[0].id;
    expect(getDelivery('here', id)).toMatchObject({ state: 'retry_later', reason: 'capability_check_unavailable' });
    expect(report).toHaveBeenCalledTimes(1);
    const [reported, options] = report.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported).toMatchObject({ message: 'annex_delivery_capability_failed', stack: undefined });
    expect(Object.getOwnPropertyNames(reported)).toEqual(['stack', 'message']);
    expect(options).toEqual({ origin: 'main', handled: true });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
    nextRetry();
    await flushOutbox(OTHER);
    expect(support).toHaveBeenCalledTimes(2);
    expect(getDelivery('here', id)).toMatchObject({ state: 'refused', reason: 'durable_delivery_unsupported', attempts: 0 });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });

  it('renegotiates on reconnect and quarantines an uncertain attempt if the peer downgraded', async () => {
    vi.spyOn(transport, 'supportsDurableDelivery').mockResolvedValueOnce(true).mockResolvedValue(false);
    respond = (urlPath) => urlPath.endsWith('/connections') ? { status: 200, body: { directions: [] } } : { status: 503, body: {} };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'accepted maybe' });
    const id = waitingFor(OTHER)[0].id;
    restart();
    nextRetry();
    await syncDirectionsWith(OTHER);
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'indeterminate', reason: 'durable_delivery_unsupported' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('binds sender and receiver dedupe to pairing epochs and never sends an old queue under a new pairing', async () => {
    connected = false;
    const args = { message: 'once per pairing', idempotency_key: 'pairing-job' };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    const oldId = waitingFor(OTHER)[0].id;
    state.peerPairing = 'new-peer-epoch';
    await flushOutbox(OTHER);
    expect(getDelivery('here', oldId)).toMatchObject({ state: 'refused', reason: 'pairing_changed' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    expect(waitingFor(OTHER)[0].id).not.toBe(oldId);
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ epoch: { sender: 'peer-epoch', receiver: 'self-epoch' } }), now)).toMatchObject({ error: 'pairing_changed' });
    expect(seen).toHaveLength(0);
  });

  it('makes refusal/expiry durable and notifies the sender, retrying an unacknowledged notice on restart', async () => {
    connected = false;
    const notices = vi.fn(async () => {});
    restart({ onDeliveryFailure: notices });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'old' });
    const id = waitingFor(OTHER)[0].id;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DELIVERY_MAX_AGE_MS + 1);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(getDelivery('here', id)).toMatchObject({ state: 'expired', reason: 'expired' });
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ callId: id, state: 'expired' }));
    restart({ onDeliveryFailure: notices });
    await Promise.resolve();
    expect(notices).toHaveBeenCalledTimes(1);
  });

  it('notifies the sender exactly once when a queued call receives a final refusal', async () => {
    connected = false;
    const notices = vi.fn(async () => {});
    restart({ onDeliveryFailure: notices });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'not allowed' });
    const id = waitingFor(OTHER)[0].id;
    respond = (_path, body) => ({
      status: 200,
      body: {
        result: { ...ok('send_message is turned off'), isError: true },
        delivery: { callId: body.callId, state: 'refused', reason: 'tool_denied', receiptAt: new Date().toISOString() },
      },
    });
    connected = true;
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(getDelivery('here', id)).toMatchObject({ state: 'refused', reason: 'tool_denied' });
    expect(notices).toHaveBeenCalledTimes(1);
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({
      callId: id, callerId: 'here', targetId: `there@${OTHER}`, state: 'refused', reason: 'tool_denied',
    }));
  });

  it('refuses queued work when sender authorization is revoked without POSTing it', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'no longer allowed' });
    const id = waitingFor(OTHER)[0].id;
    restart({ authorizeQueuedCall: async () => ({ allowed: false, reason: 'agent.message was revoked' }) });
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'refused', reason: 'authorization_revoked' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });

  it('persists trusted causal context outside agent arguments and enforces the depth bound', async () => {
    connected = false;
    const context = { rootId: 'root', depth: 3, parentId: 'parent' };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one', idempotency_key: 'context-1' }, now, context);
    restart();
    expect(waitingFor(OTHER)[0].body.context).toEqual(context);
    expect(waitingFor(OTHER)[0].body.args).not.toHaveProperty('context');
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'two' }, now, { rootId: 'root', depth: 9 })).isError).toBe(true);
    expect(waitingFor(OTHER)).toHaveLength(1);
  });

  it('routes only fixed controller capabilities before editable directions and never falls through when disabled', async () => {
    let available = true;
    const receive = vi.fn(async () => ok('controller receipt'));
    restart({ remoteDispatcher: { isTarget: (id) => id === 'controller', isAvailable: () => available, receive } });
    const body = call({ callId: 'controller-call', to: 'controller', tool: 'hand_off_request', args: { request: 'triage', context: { rootId: 'forged', depth: 0 } }, context: { rootId: 'real', depth: 2 } });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ result: ok('controller receipt') });
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({
      origin: { machineId: OTHER, machineName: 'Studio', agentId: 'sender', agentName: 'Scout' },
      cause: { rootId: 'real', depth: 2 }, deliveryId: 'controller-call',
    }));
    await setConnectionLink(inbound.from, { agentId: 'controller' }, true);
    for (const tool of ['wake_agent', 'clear_agent', 'read_output']) {
      expect(await receiveAgentCall(OTHER, { ...body, callId: `unsafe-${tool}`, tool }, now)).toMatchObject({ error: 'tool_not_allowed' });
    }
    available = false;
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ error: 'dispatcher_unavailable' });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(await receiveAgentCall(OTHER, { ...body, to: 'receiver' }, now)).toMatchObject({ error: 'tool_not_allowed' });
    expect(await receiveAgentCall(OTHER, { ...body, context: { rootId: 'real', depth: 9 } }, now)).toMatchObject({ error: 'invalid_call' });
  });

  it('rejects changed content even while the original durable call is still running', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => { await gate; return ok('accepted'); });
    restart({ runTool: run });
    const body = call({ callId: 'running-conflict' });
    const first = receiveAgentCall(OTHER, body, now);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await receiveAgentCall(OTHER, { ...body, args: { message: 'changed' } }, now)).toMatchObject({ error: 'idempotency_conflict' });
    release();
    expect(await first).toMatchObject({ delivery: { state: 'delivered' } });
  });

  it('preserves a large first read while bounding its durable replay without repeating the runner', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const output = 'x'.repeat(80 * 1024);
    const run = vi.fn(async () => ok(output));
    restart({ runTool: run });
    const body = call({ callId: 'large-read', tool: 'read_output' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ result: ok(output) });
    restart({ runTool: run });
    const replay = await receiveAgentCall(OTHER, body, now);
    expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThan(64 * 1024);
    expect(replay).toMatchObject({ delivery: { state: 'delivered' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('quarantines a contradictory success marker on an error instead of retrying an uncertain effect', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const run = vi.fn(async () => ({ ...ok('partial effect'), isError: true, annexDelivery: { state: 'delivered' as const } }));
    restart({ runTool: run });
    const body = call({ callId: 'contradictory' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    restart({ runTool: run });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not send from a stopped lifecycle after an awaited capability lookup resumes', async () => {
    let release!: (supported: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const support = vi.spyOn(transport, 'supportsDurableDelivery').mockReturnValueOnce(gate).mockResolvedValue(true);
    const pending = forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one lifecycle only' });
    await vi.waitFor(() => expect(support).toHaveBeenCalledTimes(1));
    restart();
    release(true);
    await pending;
    await vi.waitFor(() => expect(waitingFor(OTHER)).toHaveLength(0));
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('quarantines migrated legacy work whose prior acceptance cannot be proven', async () => {
    const queuedAt = new Date().toISOString();
    fs.writeFileSync(path.join(state.base, 'recovered-legacy.json'), JSON.stringify({ version: 1, items: [{
      id: 'legacy-call', machine: OTHER, queuedAt,
      body: { ...call({ callId: 'legacy-call', to: 'there' }), from: { agentId: 'here', name: 'Sender' } },
    }] }));
    restart({ deliveryStore: createAnnexDeliveryStore('recovered-legacy.json') });
    await flushOutbox(OTHER);
    await vi.waitFor(() => expect(getDelivery('here', 'legacy-call')).toMatchObject({ state: 'indeterminate', reason: 'legacy_delivery_unverified' }));
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });
});

describe('keeping both machines\' copies of a connection', () => {
  it('takes the other machine\'s share from its answer, so both copies meet when only one can reach the other', async () => {
    const at = new Date(now).toISOString();
    respond = (urlPath) => (urlPath === '/api/v1/network/connections'
      ? { status: 200, body: { applied: 0, directions: [{ from: { agentId: 'there', machine: OTHER, name: 'Far agent' }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: at }] } }
      : { status: 200, body: { result: ok('x') } });
    expect(await syncDirectionsWith(OTHER)).toBe(true);
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeTruthy();
  });

  it('exchanges a source with a fake peer without converting it into a user link', async () => {
    const pair = { from: { agentId: 'here' }, to: { agentId: 'there', machineId: OTHER } };
    await updateAgentNetworkLinks([pair], { agentId: 'here', machineId: SELF, name: 'Helper' }, 'add');
    posts = [];
    await syncDirectionsWith(OTHER);
    const request = posts.find((p) => p.path === '/api/v1/network/connections')!;
    expect(request.body.directions).toEqual([expect.objectContaining({ link: true, userLink: false, agentLinks: [expect.objectContaining({ agentId: 'here', machineId: SELF, name: 'Helper' })] })]);
    const at = new Date(now).toISOString();
    const incoming = { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: ['clear_agent'], link: true, userLink: false, agentLinks: [{ agentId: 'maker', machineId: OTHER, name: 'Maker', createdAt: at }], updatedAt: at };
    await receiveDirections(OTHER, { v: AGENT_CALL_VERSION, directions: [incoming] }, now);
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })).toMatchObject({ agentLinks: [expect.objectContaining({ name: 'Maker', machineId: OTHER })] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeUndefined();
  });

  it('refuses a peer creating a direction between two local agents', async () => {
    const at = new Date(now).toISOString();
    const entry = { from: { agentId: 'here', machine: SELF }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, userLink: false,
      agentLinks: [{ agentId: 'maker', machineId: OTHER, createdAt: at }], updatedAt: at };
    expect(await receiveDirections(OTHER, { v: AGENT_CALL_VERSION, directions: [entry] }, now)).toEqual({ applied: 0 });
    expect(getConnectionDirection({ agentId: 'here' }, { agentId: 'receiver' })).toBeUndefined();
  });

  it('refuses a peer relaying a direction between this computer and a third computer', async () => {
    state.thirdRole = 'member';
    const at = new Date(now).toISOString();
    const direction = { from: { agentId: 'receiver', machine: SELF }, to: { agentId: 'there', machine: THIRD }, disabledTools: [], link: true, userLink: false,
      agentLinks: [{ agentId: 'maker', machineId: OTHER, createdAt: at }], updatedAt: at };
    expect(await receiveDirections(OTHER, { v: AGENT_CALL_VERSION, directions: [direction] }, now)).toEqual({ applied: 0 });
    expect(getConnectionDirection({ agentId: 'receiver' }, { agentId: 'there', machineId: THIRD })).toBeUndefined();
  });

  it('accepts only a creator’s source updates, except an endpoint’s user-removal tombstone', async () => {
    state.thirdRole = 'member';
    const at = new Date(now).toISOString();
    const later = new Date(now + 1000).toISOString();
    const from = { agentId: 'receiver', machine: SELF };
    const to = { agentId: 'there', machine: OTHER };
    const foreign = { agentId: 'foreign', machineId: THIRD, createdAt: at };
    const local = { agentId: 'local', machineId: SELF, createdAt: at };
    const own = { agentId: 'maker', machineId: OTHER, createdAt: at };
    const pair = { from: { agentId: 'receiver' }, to: { agentId: 'there', machineId: OTHER } };
    await putConnectionDirection({ ...pair, disabledTools: [], agentLinks: [foreign, local], updatedAt: at });
    const entry = { from, to, disabledTools: ['send_file'], link: true, userLink: false, setByAgent: 'foreign', agentLinks: [
      { ...foreign, removedAt: later }, { ...local, createdAt: later }, { ...foreign, agentId: 'forged', createdAt: later }, own,
    ], updatedAt: later };
    await receiveDirections(OTHER, { v: AGENT_CALL_VERSION, directions: [entry] }, now + 1000);
    expect(getConnectionDirection(pair.from, pair.to)?.agentLinks).toEqual([foreign, local, own]);
    expect(getConnectionDirection(pair.from, pair.to)).toMatchObject({ disabledTools: [] });
    expect(getConnectionDirection(pair.from, pair.to)?.setByAgent).toBeUndefined();
    const removedAt = new Date(now + 2000).toISOString();
    await receiveDirections(OTHER, { v: AGENT_CALL_VERSION, directions: [{ ...entry, agentLinks: [{ ...foreign, removedAt, removedByUser: true }], link: false, updatedAt: removedAt }] }, now + 2000);
    expect(getConnectionDirection(pair.from, pair.to)?.agentLinks).toEqual([{ ...foreign, removedAt, removedByUser: true }, local, own]);
  });

  it('on connect, sends what waited only after the connections got through', async () => {
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'later' });
    connected = true;
    posts = [];
    respond = (urlPath) => (urlPath === '/api/v1/network/connections' ? { status: 503, body: {} } : { status: 200, body: { result: ok('x') } });
    connectedListener!(OTHER);
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/v1/network/connections')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.some((p) => p.path === '/api/v1/network/agent-call')).toBe(false);
    expect(waitingFor(OTHER)).toHaveLength(1);
  });

  it('runs a retry that arrives during the first run only once', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const once = call({ callId: 'slow' });
    const [a, b] = await Promise.all([receiveAgentCall(OTHER, once, now), receiveAgentCall(OTHER, once, now)]);
    expect(a).toEqual(b);
    expect(seen).toHaveLength(1);
  });

  it('sends the other machine its share, with both ends naming their machine', async () => {
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: THIRD }, true);
    posts = [];
    await syncDirectionsWith(OTHER);
    // Each machine gets only its own share.
    expect(posts.filter((p) => p.path === '/api/v1/network/connections').every((p) => p.machine === OTHER || p.machine === THIRD)).toBe(true);
    const sent = posts.filter((p) => p.path === '/api/v1/network/connections' && p.machine === OTHER).at(-1)!;
    expect(sent.body.directions).toEqual([expect.objectContaining({
      from: { agentId: 'here', machine: SELF, name: 'Helper' }, to: expect.objectContaining({ agentId: 'there', machine: OTHER }), link: true,
    })]);
  });

  it('a change to a direction with another machine is sent at once', async () => {
    posts = [];
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/v1/network/connections')).toBe(true));
  });

  it('takes the newer copy of a direction between the two machines, learns names, and nothing else', async () => {
    const at = new Date(now).toISOString();
    const result = await receiveDirections(OTHER, { v: 1, directions: [
      { from: { agentId: 'there', machine: OTHER, name: 'Far agent' }, to: { agentId: 'receiver', machine: SELF }, disabledTools: ['clear_agent'], link: true, updatedAt: at },
      // Between the sender and a third machine: not the sender's to say here.
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'x', machine: THIRD }, disabledTools: [], link: true, updatedAt: at },
      // Two agents here: not the sender's either.
      { from: { agentId: 'here', machine: SELF }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: at },
    ] });
    expect(result).toEqual({ applied: 1 });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })).toMatchObject({ disabledTools: ['clear_agent'], link: expect.anything(), updatedAt: at });
    expect(remoteAgentName(`there@${OTHER}`)).toBe('Far agent');
    expect(listAllConnectionDirections().some((d) => d.to.machineId === THIRD || (d.from.agentId === 'here' && d.to.agentId === 'receiver'))).toBe(false);

    // An older copy loses; a newer one, with the link off, wins.
    const older = new Date(now - 1000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{ from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: false, updatedAt: older }] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeTruthy();
    const newer = new Date(now + 1000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{ from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: false, updatedAt: newer }] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeFalsy();
  });

  it('keeps agent source identity distinct from a user link, and accepts legacy boolean links', async () => {
    const at = new Date(now).toISOString();
    const base = { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: ['clear_agent'], link: true, updatedAt: at };
    await receiveDirections(OTHER, { v: 1, directions: [{ ...base, userLink: false, agentLinks: [{ agentId: 'maker', machineId: OTHER, createdAt: at }], setByAgent: 'maker' }] });
    const saved = getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' });
    expect(saved?.link).toBeUndefined();
    expect(saved?.agentLinks).toEqual([{ agentId: 'maker', machineId: OTHER, createdAt: at }]);
    const later = new Date(now + 1000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{ ...base, updatedAt: later }] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeTruthy();
  });

  it('refuses a list it can\'t read', async () => {
    expect(await receiveDirections(OTHER, { v: 2, directions: [] })).toMatchObject({ status: 400 });
    expect(await receiveDirections(OTHER, null)).toMatchObject({ status: 400 });
  });
});
