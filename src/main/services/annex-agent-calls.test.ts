import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
const SELF = Array(16).fill('aa').join(':');
const OTHER = Array(16).fill('bb').join(':');
const THIRD = Array(16).fill('cc').join(':');
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: SELF.toUpperCase() }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [
  { fingerprint: OTHER.toUpperCase(), alias: 'Studio', role: 'member', kind: 'desktop' },
  // A one-to-one pairing: not in the network.
  { fingerprint: THIRD.toUpperCase(), alias: 'Old Mac', role: 'satellite' },
] }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-agent-calls-'));

import {
  AGENT_CALL_VERSION, LOOP_LIMIT, RATE_LIMIT, currentRemoteCaller, forwardAgentCall, receiveAgentCall, receiveDirections,
  remoteAgentName, startAgentCalls, _clearOutboxForTesting, syncDirectionsWith, waitingFor, flushOutbox, isNetworkComputer, type AgentCallTransport, type RemoteCaller,
} from './annex-agent-calls';
import {
  getConnectionDirection, listAllConnectionDirections, removeConnectionDirections, setConnectionLink, setConnectionTools,
} from './connection-grants-store';
import type { McpToolResult } from './clubhouse-mcp/types';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const textOf = (r: McpToolResult) => (r.content[0] as { text: string }).text;

let connected = true;
let posts: Array<{ machine: string; path: string; body: Record<string, unknown> }> = [];
let respond: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: { result: ok('done there') } });
let connectedListener: ((machine: string) => void) | null = null;
const seen: Array<{ tool: string; targetId: string; callerId: string; args: Record<string, unknown>; caller?: RemoteCaller }> = [];

const transport: AgentCallTransport = {
  connected: () => connected,
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
  posts = [];
  seen.length = 0;
  respond = () => ({ status: 200, body: { result: ok('done there') } });
  now += 3_600_000;
  stop = startAgentCalls({
    transport,
    runTool: async (tool, targetId, callerId, args) => { seen.push({ tool, targetId, callerId, args, caller: currentRemoteCaller() }); return ok('ran here'); },
    describeLocalAgent: async (id) => (id === 'receiver' ? { name: 'Builder' } : id === 'here' ? { name: 'Helper', projectName: 'Atlas' } : undefined),
  });
});
afterEach(() => stop());

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
    expect(result).toEqual({ result: ok('ran here') });
    expect(seen[0]).toMatchObject({ tool: 'send_message', targetId: 'receiver', callerId: `sender@${OTHER}`, args: { message: 'hi' } });
    expect(seen[0].caller).toEqual({ name: 'Scout', projectName: 'Atlas', machineName: 'Studio', targetName: 'Builder' });
    expect(await receiveAgentCall(OTHER, call({ tool: 'clear_agent' }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('wakes an agent here when the link allows it, and not when wake is switched off on it (#3056: message, wake and read)', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: { message: 'start on it' } }), now)).toEqual({ result: ok('ran here') });
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
    expect(await receiveAgentCall(OTHER, call({ to: `receiver@${SELF}` }), now)).toEqual({ result: ok('ran here') });
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
    expect(await receiveAgentCall(OTHER, once, now)).toEqual({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, once, now)).toEqual({ result: ok('ran here') });
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
      disabledTools: [], link: true, updatedAt: at,
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
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Not connected there yet, for a message just queued: the link may still be on its way.
    respond = () => ({ status: 403, body: { error: 'not_connected' } });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Any other refusal is final: the tool is off there.
    respond = () => ({ status: 403, body: { error: 'tool_denied' } });
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
    respond = () => ({ status: 200, body: { result: ok('ok') } });
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
    respond = () => ({ status: 200, body: { result: ok('ok') } });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
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

  it('refuses a list it can\'t read', async () => {
    expect(await receiveDirections(OTHER, { v: 2, directions: [] })).toMatchObject({ status: 400 });
    expect(await receiveDirections(OTHER, null)).toMatchObject({ status: 400 });
  });
});
