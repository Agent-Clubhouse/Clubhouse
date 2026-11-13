/** Transport → real receiver → real agent tool → real Dispatcher delivery/wake.
 * Only the CLI/runtime boundary and saved device/config I/O are fakes. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ base: '', running: false, enabled: true, busy: false, pairing: 'peer-pairing', config: vi.fn(), spawn: vi.fn(), send: vi.fn(), grant: vi.fn() }));
const SELF = Array(16).fill('aa').join(':');
const PEER = Array(16).fill('bb').join(':');
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: SELF }) }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: 'self-pairing' }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [{ fingerprint: PEER, alias: 'Laptop', role: 'member', kind: 'desktop', pairingId: state.pairing }] }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  getDispatcherAgentId: () => 'controller', getDispatcherPath: () => state.base,
  isDispatcherAgentId: (id: string) => id === 'controller', isDispatcherIdentityAgentId: (id: string) => id === 'controller' || id === 'chat',
  isDispatcherEnabled: () => state.enabled, dispatcherDisplayName: () => 'Dispatcher controller', onDispatcherChanged: () => () => {},
}));
vi.mock('./dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => state.enabled }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (id: string) => id === 'controller' && state.running ? { runtime: 'chat', projectPath: state.base } : undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => state.running ? {
  kind: 'chat', sendMessage: state.send, getState: () => state.busy ? 'running' : 'idle', hasPendingWork: () => false,
} : undefined }));
vi.mock('./agent-system', () => ({
  isAgentRunning: () => state.running, isAgentStopping: () => false, waitForAgentStopped: async () => true,
  spawnAgent: state.spawn,
}));
vi.mock('./agent-config', () => ({
  getDurableConfig: state.config,
  listDurable: async () => [],
}));
vi.mock('./project-store', () => ({ list: async () => [] }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: async () => [] }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ decideGrant: state.grant }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-receiver-'));
import { receiveAgentCall, startAgentCalls, _clearOutboxForTesting } from './annex-agent-calls';
import { federationReceiver } from './dispatcher-federation-receiver';
import { learnFederationController, watchFederation } from './dispatcher-federation';
import { registerAgentTools } from './clubhouse-mcp/tools/agent-tools';
import { _resetForTesting as resetRegistry } from './clubhouse-mcp/tool-registry';
import { _resetDispatcherDeliveryForTesting } from './clubhouse-mcp/tools/dispatcher-delivery';
let stop = () => {};
let stopSource = () => {};
const call = (id = 'wake-call', tool = 'send_message') => ({
  v: 1, callId: id, from: { agentId: 'peer-controller', name: 'Laptop controller' }, to: 'controller', tool,
  args: { message: 'Please check the build.' }, epoch: { sender: 'peer-pairing', receiver: 'self-pairing' },
});
beforeEach(async () => {
  state.running = false; state.enabled = true; state.busy = false; state.pairing = 'peer-pairing';
  state.config.mockResolvedValue({ id: 'controller', name: 'Dispatcher', orchestrator: 'claude-code', model: 'fake' });
  state.spawn.mockImplementation(async () => { state.running = true; });
  state.send.mockResolvedValue({ delivery: 'prompt' });
  // Remote callers have no local grant. The receiver's own subscription may wake itself.
  state.grant.mockReturnValue({ outcome: 'refuse' });
  resetRegistry(); registerAgentTools(); _resetDispatcherDeliveryForTesting(); await _clearOutboxForTesting();
  stopSource = watchFederation(() => {});
  await learnFederationController(PEER, { agentId: 'peer-controller', name: 'Laptop controller', enabled: true });
  stop = startAgentCalls({
    transport: { connected: () => false, supportsDurableDelivery: async () => true, post: async () => ({ status: 503, body: {} }), machineName: () => 'Laptop', onConnected: () => () => {} },
    describeLocalAgent: async () => ({ name: 'Dispatcher controller' }), runTool: async () => { throw new Error('must use the production controller receiver'); },
    remoteDispatcher: federationReceiver,
  });
});
afterEach(() => { stop(); stopSource(); vi.clearAllMocks(); });
afterAll(() => { fs.rmSync(state.base, { recursive: true, force: true }); });
describe('production sleeping-controller delivery (#3345)', () => {
  it('wakes an enabled sleeping controller under receiver-local rules, preserves origin, and replays only its durable receipt', async () => {
    const request = call();
    const first = await receiveAgentCall(PEER, request);
    expect(first).toMatchObject({ delivery: { state: 'delivered' }, result: { content: [{ text: expect.stringContaining('was woken') }] } });
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(state.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'controller', projectPath: state.base,
      mission: expect.stringContaining('[FROM:Laptop controller on Laptop]'),
      missionRouted: expect.arrayContaining([expect.objectContaining({ sender: expect.objectContaining({ agentId: `peer-controller@${PEER}` }) })]),
    }));
    expect(state.grant).not.toHaveBeenCalled();
    expect(await receiveAgentCall(PEER, request)).toEqual(first);
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });
  it('does not wake after the authenticated pairing changes during saved configuration I/O', async () => {
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => { reading = resolve; });
    let release!: (value: Record<string, string>) => void;
    state.config.mockImplementation(() => { reading(); return new Promise((resolve) => { release = resolve; }); });
    const pending = receiveAgentCall(PEER, call('revoked-during-wake'));
    await readStarted;
    state.pairing = 'replacement-pairing';
    release({ id: 'controller', name: 'Dispatcher', orchestrator: 'claude-code', model: 'fake' });
    expect(await pending).toMatchObject({ delivery: { state: 'refused', reason: 'authorization_revoked' } });
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it('keeps busy input in the durable sender queue and refuses disabled or explicit wake calls', async () => {
    state.running = true; state.busy = true;
    expect(await receiveAgentCall(PEER, call('busy'))).toMatchObject({ delivery: { state: 'retry_later' } });
    expect(state.send).not.toHaveBeenCalled();
    state.running = false; state.enabled = false;
    expect(await receiveAgentCall(PEER, call('off'))).toMatchObject({ error: 'dispatcher_unavailable' });
    state.enabled = true;
    expect(await receiveAgentCall(PEER, call('explicit-wake', 'wake_agent'))).toMatchObject({ error: 'tool_not_allowed' });
    expect(state.spawn).not.toHaveBeenCalled();
  });
});
