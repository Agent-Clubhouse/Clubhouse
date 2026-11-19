import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { noteAgentStarting, _resetAgentDisplayStateForTesting } from './agent-display-state';
import { ORCHESTRATION_DEFAULTS } from '../../shared/orchestration-policy';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const m = vi.hoisted(() => ({ target: vi.fn(), settings: vi.fn(), provider: vi.fn(), running: vi.fn(), policies: vi.fn(), helpers: vi.fn(), requests: vi.fn(), bindings: vi.fn(), sources: vi.fn(), satellite: vi.fn(), peer: vi.fn(), directions: vi.fn(), dispatcher: vi.fn(), dispatcherOn: vi.fn(), agentCard: vi.fn(), actions: vi.fn(), canvases: vi.fn(), status: vi.fn(), entries: vi.fn(), template: vi.fn(), mcp: vi.fn(), branch: vi.fn(), transcript: vi.fn(), historical: vi.fn(), envCached: vi.fn(), catalog: vi.fn(), connection: vi.fn(), work: vi.fn(), realWitness: false, base: '', registration: vi.fn(), runtime: vi.fn(), useRealRuntime: false }));
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), execSync: vi.fn(() => '') }));
vi.mock('../util/shell', async (original) => ({ ...await original<typeof import('../util/shell')>(), isShellEnvironmentCached: m.envCached }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./read-only-agent-target-witness', async (original) => {
  const actual = await original<typeof import('./read-only-agent-target-witness')>();
  return { ...actual, captureReadOnlyAgentTargetWitness: (...args: Parameters<typeof actual.captureReadOnlyAgentTargetWitness>) => m.realWitness ? actual.captureReadOnlyAgentTargetWitness(...args) : { current: () => true } };
});
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
vi.mock('./remote-agent-settings', () => ({ readRemoteAgentSettings: m.settings }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: m.provider, isAgentRunning: m.running }));
vi.mock('./agent-runtime/pty-runtime', () => ({ PtyAgentRuntime: class { kind = 'pty'; constructor(readonly agentId: string) {} } }));
vi.mock('./pty-manager', () => ({ isRunning: () => m.running() }));
vi.mock('./agent-runtime', async (original) => {
  const actual = await original<typeof import('./agent-runtime')>();
  return { ...actual, getAgentRuntime: (id: string) => m.useRealRuntime ? actual.getAgentRuntime(id) : m.runtime() };
});
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.registration } }));
vi.mock('./orchestration-policy', () => ({ resolveOrchestrationPolicies: m.policies }));
vi.mock('./orchestration-settings', () => ({ getGlobalHelperCap: () => 20 }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: m.helpers }));
vi.mock('./read-only-helper-work', () => ({ readOnlyHelperWork: m.work, HELPER_TRANSFORM_UNAVAILABLE: 'Custom Git filters or text transforms are not run for helper work.' }));
vi.mock('./helper-start-requests', () => ({ listStartRequests: m.requests }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: m.bindings } }));
vi.mock('./clubhouse-mcp/bridge-server', () => ({ getAgentConnection: m.connection, getCurrentAgentConnection: () => m.connection()?.current ? m.connection() : null }));
vi.mock('./annex-client', () => ({ getSatellite: m.satellite }));
vi.mock('./annex-peers', () => ({ getPeer: m.peer }));
vi.mock('./connection-sources', () => ({ listConnectionSources: m.sources }));
vi.mock('./connection-grants-store', () => ({ listConnectionDirectionsForInspection: m.directions }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: m.dispatcher, isDispatcherIdentityAgentId: (id: string) => id === 'disp' }));
vi.mock('./dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: m.dispatcherOn }));
vi.mock('./dispatcher/dispatcher-agent-card-source', () => ({ readAgentCardView: m.agentCard }));
vi.mock('./agent-grants-service', () => ({ viewOf: () => ({ rows: [] }) }));
vi.mock('./actions', () => ({ listActions: m.actions, actionNames: () => ({ agent: () => 'Selected', project: () => 'Project' }) }));
vi.mock('./canvas-store-reader', () => ({ getAgentCanvasMemberships: m.canvases }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ liveEntries: m.entries, getTemplate: m.template }), statusFor: m.status }));
vi.mock('./agent-settings-service', () => ({ readMcpConfig: m.mcp, readLaunchWrapper: async () => undefined, readDefaultMcps: async () => [] }));
vi.mock('./git-service', () => ({ getBranchChanges: m.branch }));
vi.mock('../orchestrators', () => ({ isSessionCapable: () => true, getProvider: (id: string) => m.catalog(id) }));

import { ChatDetailsRecorder } from './agent-runtime/chat-details-evidence';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import { readRemoteAgentDetails } from './remote-agent-details';
const agent = () => ({ id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-11-18', worktreePath: '/host/selected', branch: 'feature' });
const project = { id: 'p1', name: 'Project', path: '/host/project' };
const setting = () => ({ version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', model: 'model', runtime: 'terminal', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: null } });
beforeEach(() => {
  _resetAgentDisplayStateForTesting();
  m.envCached.mockReturnValue(true); m.realWitness = false; m.useRealRuntime = false; m.registration.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined);
  m.target.mockResolvedValue({ agent: agent(), project });
  m.settings.mockResolvedValue({ status: 200, body: setting() });
  m.provider.mockResolvedValue({ id: 'codex-cli', conventions: {}, readSessionTranscript: m.transcript });
  m.transcript.mockResolvedValue([]); m.historical.mockResolvedValue([{ type: 'result', duration_ms: 5000, total_cost_usd: 1.25 }]);
  m.catalog.mockImplementation((id: string) => ({ id, displayName: id === 'claude-code' ? 'Host Current Claude' : id, readSessionTranscript: m.historical }));
  m.running.mockReturnValue(false);
  m.policies.mockResolvedValue(new Map([['a1', ORCHESTRATION_DEFAULTS]]));
  m.helpers.mockResolvedValue([]); m.requests.mockReturnValue([]); m.work.mockResolvedValue({ dirty: 0, unpushed: 0, unmerged: null });
  m.bindings.mockReturnValue([]); m.sources.mockResolvedValue({ pairs: [], unreadable: [] }); m.satellite.mockReturnValue(null); m.peer.mockReturnValue(undefined); m.directions.mockReturnValue([]);
  m.dispatcher.mockReturnValue({ agentId: 'disp', config: { name: 'Host Dispatcher' } }); m.dispatcherOn.mockReturnValue(false);
  m.actions.mockReturnValue([]); m.canvases.mockResolvedValue([]);
  m.status.mockResolvedValue({ managed: false, running: false, waiting: false, changes: [] }); m.entries.mockResolvedValue({}); m.template.mockResolvedValue({ name: 'Template' });
  m.mcp.mockResolvedValue([]); m.branch.mockResolvedValue({ available: true, branch: 'feature', base: 'main', files: [] }); m.connection.mockReturnValue(null);
});
const read = async () => {
  const response = await readRemoteAgentDetails('a1', () => true);
  expect(response.status).toBe(200);
  expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
  return response.body as RemoteAgentDetails;
};
describe('host selected-agent Details projections', () => {
  it.each(['same', 'provider-changed', 'folder-changed'] as const)('separates current registered provider from inherited next-start choice and fences late evidence: %s', async (mode) => {
    m.provider.mockResolvedValue({ id: 'codex-cli', displayName: 'Host Next Codex', conventions: {} });
    m.settings.mockResolvedValue({ status: 200, body: { ...setting(), provider: 'Host Next Codex', providerId: 'codex-cli' } });
    const recorder = new ChatDetailsRecorder('current-claude');
    recorder.observe({ v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', resumed: false, nativeSessionId: 'n1', cliVersion: '1.2.3', capabilities: MINIMAL_CHAT_CAPABILITIES, cwd: '/host/selected' } });
    const evidence = vi.fn(() => recorder.read(2));
    m.runtime.mockReturnValue({ kind: 'chat', getSessionId: () => 's1', getNativeSessionId: () => 'n1', getDetailsEvidence: evidence });
    const registration = { nonce: 'PRIVATE_NONCE', runtime: 'chat', orchestrator: 'claude-code', cwd: '/host/selected' };
    m.registration.mockReturnValue(registration); m.running.mockReturnValue(true);
    m.canvases.mockImplementation(async () => { if (mode === 'provider-changed') registration.orchestrator = 'codex-cli'; if (mode === 'folder-changed') registration.cwd = '/host/replacement'; return []; });
    const response = await readRemoteAgentDetails('a1', () => true);
    expect(response.status).toBe(mode === 'same' ? 200 : 409);
    if (mode === 'same') {
      expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
      expect(response.body).toMatchObject({ providerId: 'claude-code', providerLabel: 'Host Current Claude', settings: { providerId: 'codex-cli', provider: 'Host Next Codex' }, providerEvidence: { providerId: 'claude-code', values: { cliVersion: '1.2.3' } } });
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_NONCE');
    } else { expect(evidence).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('1.2.3'); }
  });
  it.each(['same', 'replacement', 'revoked'] as const)('projects current provider facts only after the complete Details assembly fence: %s', async (mode) => {
    const recorder = new ChatDetailsRecorder('display-a');
    recorder.observe({ v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { driver: 'claude_agent_sdk', provider: 'claude-code', resumed: false, nativeSessionId: 'n1', cwd: '/host/selected', cliVersion: 'INITIAL_VERSION', capabilities: MINIMAL_CHAT_CAPABILITIES } });
    const getDetailsEvidence = vi.fn(() => recorder.read(2));
    const runtime = { kind: 'chat', getSessionId: () => 's1', getNativeSessionId: () => 'n1', getDetailsEvidence };
    m.runtime.mockReturnValue(runtime); m.running.mockReturnValue(true);
    const registration = { nonce: 'private-auth-nonce', runtime: 'chat' };
    m.registration.mockReturnValue(registration);
    m.provider.mockResolvedValue({ id: 'claude-code', conventions: {} });
    let authorized = true;
    m.canvases.mockImplementation(async () => {
      if (mode === 'replacement') m.registration.mockReturnValue({ ...registration, nonce: 'new-private-nonce' });
      if (mode === 'revoked') authorized = false;
      return [];
    });
    const response = await readRemoteAgentDetails('a1', () => authorized);
    expect(response.status).toBe(mode === 'same' ? 200 : mode === 'replacement' ? 409 : 403);
    if (mode === 'same') {
      expect(isRemoteAgentDetails(response.body, 'a1')).toBe(true);
      expect((response.body as RemoteAgentDetails).providerEvidence).toMatchObject({ runId: 'display-a', values: { cliVersion: 'INITIAL_VERSION' } });
      expect(JSON.stringify(response.body)).not.toContain('private-auth-nonce');
    } else { expect(getDetailsEvidence).not.toHaveBeenCalled(); expect(JSON.stringify(response.body)).not.toContain('INITIAL_VERSION'); }
  });
  it('does not describe a connected peer without a snapshot as cached name evidence', async () => {
    m.directions.mockReturnValue([{ from: { agentId: 'a1' }, to: { agentId: 'b', machineId: 'm1' }, disabledTools: [], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' }]);
    m.satellite.mockReturnValue({ alias: 'Studio', state: 'connected' });
    const connections = (await read()).cards.find((c) => c.id === 'connections')!;
    expect(connections.rows.find((r) => r.label === 'b')?.value).toContain('names from retained metadata');
    expect(JSON.stringify(connections)).not.toContain('names from cached snapshot');
    expect(connections.notes.join(' ')).toContain('unavailable or ambiguous');
  });
  it('folds only the selected local agent’s network directions and projects cached peer fields without raw trust records or unrelated agents', async () => {
    const base = { disabledTools: ['send_message'], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' };
    m.directions.mockReturnValue([
      { ...base, from: { agentId: 'a1' }, to: { agentId: 'b', machineId: 'm1' } },
      { ...base, from: { agentId: 'b', machineId: 'm1' }, to: { agentId: 'a1' } },
      { ...base, from: { agentId: 'a1', machineId: 'PRIVATE_FOREIGN_FROM' }, to: { agentId: 'PRIVATE_OTHER_AGENT', machineId: 'PRIVATE_OTHER_MACHINE' } },
    ]);
    m.satellite.mockImplementation((id: string) => id === 'm1' ? { alias: 'Studio', state: 'disconnected', snapshotUnavailable: true,
      snapshot: { agents: { p1: [{ id: 'b', name: 'Peer B' }, { id: 'unrelated', name: 'PRIVATE_UNRELATED_NAME' }] }, quickAgents: {} }, tlsCertificatePem: 'PRIVATE_CERTIFICATE' } : null);
    m.peer.mockReturnValue({ alias: 'Saved alias', lastSeen: '2026-11-19T00:00:00Z', publicKey: 'PRIVATE_UNUSED_TRUST_RECORD' });
    const value = await read();
    const connections = value.cards.find((c) => c.id === 'connections')!;
    expect.soft(connections.summary).toBe('0 local directions · 1 remote connections');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B')?.value).toContain('on Studio · two-way · saved network link · disconnected · names from retained metadata');
    expect.soft(connections.rows.find((r) => r.label === 'Peer B outgoing switches')?.value).toContain('Off: Send messages');
    expect.soft(connections.notes.join(' ')).not.toContain('No Clubhouse MCP wires');
    expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_OTHER|PRIVATE_UNRELATED|PRIVATE_CERTIFICATE|PRIVATE_UNUSED/i);
    expect.soft(m.satellite.mock.calls.every(([id]) => id === 'm1')).toBe(true);
  });
  it('never substitutes a different cached agent’s name when the saved network target is absent', async () => {
    m.directions.mockReturnValue([{ from: { agentId: 'a1' }, to: { agentId: 'missing', machineId: 'm1' }, disabledTools: [], link: { createdAt: '2026-11-19' }, updatedAt: '2026-11-19' }]);
    m.satellite.mockReturnValue({ alias: 'Studio', state: 'connected', snapshot: { agents: { p: [{ id: 'different', name: 'PRIVATE_OTHER_AGENT_NAME' }] }, quickAgents: {} } });
    const c = (await read()).cards.find((c) => c.id === 'connections')!;
    expect.soft(c.rows.some((r) => r.label === 'missing')).toBe(true);
    expect.soft(c.notes.join(' ')).toContain('name for missing@m1 is unavailable or ambiguous');
    expect.soft(JSON.stringify(c)).not.toContain('PRIVATE_OTHER_AGENT_NAME');
  });
  it.each(['parent-removal', 'earlier-helper-release', 'cross-project-reparent', 'disposed-reparent'] as const)('withholds complete Details when real primary membership changes after helper work: %s', async (condition) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-details-final-inventory-'));
    try {
      m.realWitness = true; m.base = path.join(root, 'profile');
      const home = path.join(root, 'home'), other = path.join(root, 'other');
      await fs.mkdir(m.base); await fs.mkdir(path.join(home, '.clubhouse'), { recursive: true }); await fs.mkdir(path.join(other, '.clubhouse'), { recursive: true });
      const selected = { ...agent(), worktreePath: home };
      const p1 = { id: 'p1', name: 'Home', path: home }, p2 = { id: 'p2', name: 'Other', path: other };
      const a = { ...selected, id: 'h1', name: 'First helper', parentAgentId: 'a1', ...(condition === 'disposed-reparent' && { disposedAt: '2026-11-19' }) };
      const b = { ...selected, id: 'h2', name: 'Second helper', parentAgentId: 'a1' };
      const cross = condition === 'cross-project-reparent' || condition === 'disposed-reparent';
      if (cross) Object.assign(a, { parentProjectPath: home, worktreePath: other });
      const homeRows = cross ? [selected] : [selected, a, b], otherRows = cross ? [a] : [];
      const homeFile = path.join(home, '.clubhouse', 'agents.json'), otherFile = path.join(other, '.clubhouse', 'agents.json');
      await fs.writeFile(homeFile, JSON.stringify(homeRows)); await fs.writeFile(otherFile, JSON.stringify(otherRows));
      await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [p1, p2] }));
      m.target.mockResolvedValue({ agent: selected, project: p1 });
      const realIndex = await vi.importActual<typeof import('./helper-index')>('./helper-index');
      let acquired = false;
      let actualReceipts: Array<{ current(): boolean }> = [];
      m.helpers.mockImplementation(async (...args: Parameters<typeof realIndex.listHelpersEverywhere>) => {
        const entries = await realIndex.listHelpersEverywhere(...args);
        expect(entries.map((entry) => entry.config.id)).toEqual(cross ? ['h1'] : ['h1', 'h2']);
        actualReceipts = args[2]?.receipts ?? [];
        expect(actualReceipts).toHaveLength(2);
        expect(actualReceipts.every((receipt) => receipt.current())).toBe(true);
        acquired = true;
        return entries;
      });
      let calls = 0;
      m.work.mockImplementation(async () => {
        if (++calls === 2 && condition === 'earlier-helper-release') await fs.writeFile(homeFile, JSON.stringify([selected, { ...a, parentAgentId: 'other' }, b]));
        return { dirty: 1, unpushed: 2, unmerged: null };
      });
      m.canvases.mockImplementation(async () => {
        if (condition === 'parent-removal') await fs.writeFile(homeFile, JSON.stringify([a, b]));
        if (cross) await fs.writeFile(otherFile, JSON.stringify([{ ...a, parentAgentId: 'other' }]));
        return [];
      });
      const result = await readRemoteAgentDetails('a1', () => true);
      expect(result.status).toBe(409);
      expect(result.body).not.toHaveProperty('cards');
      expect(acquired).toBe(true);
      expect(actualReceipts.some((receipt) => !receipt.current())).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('projects only the selected agent’s verified bounded canvas membership navigation identities', async () => {
    m.canvases.mockResolvedValue([{ name: 'Host board', scope: 'app', canvasId: 'board', viewId: 'view' }]);
    const value = await read();
    expect(value.cards.find((c) => c.id === 'canvases')?.rows).toEqual([{ label: 'Host board', value: 'Home', canvas: { scope: 'app', canvasId: 'board', viewId: 'view' } }]);
  });
  it('projects policy and the selected host folder/branch without invented usage or local defaults', async () => {
    const value = await read();
    expect(value.cards.find((c) => c.id === 'orchestrate')?.rows).toContainEqual({ label: 'At once', value: '5' });
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Folder', value: '/host/selected' });
    expect(m.branch).not.toHaveBeenCalled(); // strict paged Changes uses its own selected-target read, never this swallowing legacy reader.
    expect(m.helpers).toHaveBeenCalledWith('/host/project', 'a1', { includeDisposed: true, readOnly: true, receipts: expect.any(Array) });
    expect(m.canvases).toHaveBeenCalledWith('a1', 'p1', { strict: true });
    expect(value.cards.find((c) => c.id === 'dispatcher')?.state).toBe('not-applicable');
    expect(m.transcript).not.toHaveBeenCalled();
  });
  it('returns only touching connections and related actions, never private definitions or unrelated records', async () => {
    m.bindings.mockReturnValue([{ agentId: 'a1', targetId: 'b', targetKind: 'agent', label: 'Peer', instructions: { '*': 'PRIVATE_INSTRUCTIONS' } }, { agentId: 'x', targetId: 'y', targetKind: 'agent', label: 'UNRELATED_WIRE' }]);
    const action = (id: string, target: string) => ({ id, name: id, owner: { kind: 'agent', agentId: 'owner' }, enabled: true, trigger: { kind: 'once', at: Date.now() }, steps: [{ kind: 'message', agentId: target, message: 'PRIVATE_ACTION_MESSAGE' }] });
    m.actions.mockReturnValue([action('related', 'a1'), action('UNRELATED_ACTION', 'other')]);
    const value = await read();
    const text = JSON.stringify(value);
    expect(text).toContain('related'); expect(text).toContain('Peer');
    for (const privateText of ['PRIVATE_INSTRUCTIONS', 'PRIVATE_ACTION_MESSAGE', 'UNRELATED_ACTION', 'UNRELATED_WIRE']) expect(text).not.toContain(privateText);
  });
  it('binds last-session usage to the selected saved session and provider, not a broad session list', async () => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
    const value = await read();
    expect(m.historical).toHaveBeenCalledWith('selected-last', '/host/selected', { maxBytes: 2097152, stats: expect.any(Object), passiveLookup: true });
    expect(m.transcript).not.toHaveBeenCalled();
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Last CLI', value: 'Host Current Claude' });
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Cost', value: '$1.25' });
  });
  it.each(['missing', 'unrelated', 'unset', 'conflicting', 'partly-unset'] as const)('keeps historical provider attribution unknown with %s association', async (mode) => {
    const record = { sessionId: 'selected-last', orchestrator: 'claude-code' };
    const sessionHistory = mode === 'missing' ? undefined : mode === 'unrelated' ? [{ ...record, sessionId: 'other' }] : mode === 'unset' ? [{ sessionId: 'selected-last' }] : [record, mode === 'conflicting' ? { ...record, orchestrator: 'codex-cli' } : { sessionId: 'selected-last' }];
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory }, project });
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect.soft(m.transcript).not.toHaveBeenCalled(); expect.soft(m.historical).not.toHaveBeenCalled();
    expect.soft(c.rows).toContainEqual({ label: 'Last CLI', value: 'Not recorded unambiguously for this session' });
    expect.soft(c.notes.join(' ')).toContain('configured next-start provider is not used');
  });
  it.each(['zero', 'missing', 'truncated'] as const)('preserves historical reported values and completeness: %s', async (mode) => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }], lastSleep: { at: '2026-11-19T01:00:00Z', reason: 'exited' } }, project });
    const transcript = async (_id: string, _cwd: string, options: { stats?: Record<string, unknown> }) => {
      if (options.stats) Object.assign(options.stats, { truncated: mode === 'truncated', fileBytes: mode === 'truncated' ? 4000000 : 100, bytesRead: 100 });
      return [{ type: 'result', ...(mode !== 'missing' && { duration_ms: 0, total_cost_usd: 0 }) }];
    };
    m.transcript.mockImplementation(transcript); m.historical.mockImplementation(transcript);
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect.soft(c.rows).toContainEqual({ label: 'Duration', value: mode === 'missing' ? 'Not reported' : '0s' });
    expect.soft(c.rows).toContainEqual({ label: 'Cost', value: mode === 'missing' ? 'Not reported' : '$0.00' });
    expect.soft(c.rows.filter((r) => r.label === 'Ended')).toEqual([{ label: 'Ended', value: '2026-11-19T01:00:00Z' }]);
    expect.soft(c.rows).toContainEqual({ label: 'Why', value: 'CLI exited' });
    expect.soft(c.notes.join(' ')).toContain(mode === 'truncated' ? 'truncated' : 'complete file');
  });
  it.each(['uninstalled', 'no-transcript', 'no-results', 'unknown-completeness', 'invalid-totals', 'unsafe-id'] as const)('keeps historical availability explicit: %s', async (mode) => {
    const lastSessionId = mode === 'unsafe-id' ? '../other' : 'selected-last';
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId, sessionHistory: [{ sessionId: lastSessionId, orchestrator: 'claude-code' }] }, project });
    if (mode === 'uninstalled') m.catalog.mockReturnValue(undefined);
    else m.historical.mockResolvedValue(mode === 'no-transcript' ? null : mode === 'no-results' ? [{ type: 'user', message: 'PRIVATE_TEXT' }] : [{ type: 'result', duration_ms: mode === 'invalid-totals' ? -1 : 5000, total_cost_usd: mode === 'invalid-totals' ? Infinity : 1.25 }]);
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect(m.transcript).not.toHaveBeenCalled(); expect(JSON.stringify(c)).not.toContain('PRIVATE_TEXT');
    if (mode === 'uninstalled' || mode === 'unsafe-id') { expect(m.historical).not.toHaveBeenCalled(); expect(c.notes.join(' ')).toMatch(/does not support|cannot be read safely/); }
    else {
      expect(m.historical).toHaveBeenCalledTimes(1); expect(c.notes.join(' ')).toContain('did not report whether');
      if (mode === 'no-transcript') expect(c.notes.join(' ')).toContain('Usage is unknown');
      if (mode === 'no-results' || mode === 'invalid-totals') for (const label of ['Duration', 'Cost']) expect(c.rows).toContainEqual({ label, value: 'Not reported' });
      if (mode === 'unknown-completeness') expect(c.rows).toContainEqual({ label: 'Duration', value: '5s' });
    }
  });
  it.each(['cold', 'warm'] as const)('does not initialize shell environment for historical display: %s', async (mode) => {
    const shell = await vi.importActual<typeof import('../util/shell')>('../util/shell');
    const { execSync } = await import('child_process'); const platform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' }); shell.invalidateShellEnvironmentCache(); vi.mocked(execSync).mockClear();
      m.envCached.mockImplementation(shell.isShellEnvironmentCached);
      if (mode === 'warm') { shell.getShellEnvironment(); expect(execSync).toHaveBeenCalledTimes(1); vi.mocked(execSync).mockClear(); }
      m.historical.mockImplementation(async () => { shell.getShellEnvironment(); return [{ type: 'result', duration_ms: 0, total_cost_usd: 0 }]; });
      m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
      const c = (await read()).cards.find((c) => c.id === 'session')!;
      expect.soft(execSync).not.toHaveBeenCalled(); expect.soft(m.transcript).not.toHaveBeenCalled();
      if (mode === 'cold') { expect.soft(m.historical).not.toHaveBeenCalled(); expect.soft(c.notes.join(' ')).toContain('not cached'); expect.soft(shell.isShellEnvironmentCached()).toBe(false); }
      else { expect(m.historical).toHaveBeenCalledTimes(1); expect(c.rows).toContainEqual({ label: 'Cost', value: '$0.00' }); }
    } finally { Object.defineProperty(process, 'platform', { value: platform }); shell.invalidateShellEnvironmentCache(); }
  });
  it('keeps a limited historical native lookup unknown rather than verified missing or empty', async () => {
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
    m.historical.mockImplementation(async (_id, _cwd, options) => { options.stats.lookupIncomplete = true; return null; });
    const c = (await read()).cards.find((c) => c.id === 'session')!;
    expect(m.historical).toHaveBeenCalledWith('selected-last', '/host/selected', expect.objectContaining({ passiveLookup: true }));
    expect(c.notes.join(' ')).toContain('bounded limit or an unreadable directory'); expect(c.notes.join(' ')).toContain('availability is unknown');
    expect(c.rows.some((r) => r.label === 'Cost' || r.label === 'Duration')).toBe(false);
  });
  it.each(['small', 'truncated'] as const)('reads historical native provider file with real byte bound and unchanged storage: %s', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-history-native-'));
    const platform = process.platform;
    const shell = await vi.importActual<typeof import('../util/shell')>('../util/shell');
    const { execSync } = await import('child_process');
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' }); shell.invalidateShellEnvironmentCache();
      vi.mocked(execSync).mockReturnValue(`CLAUDE_CONFIG_DIR=${root}\n`); shell.getShellEnvironment(); vi.mocked(execSync).mockClear();
      m.envCached.mockImplementation(shell.isShellEnvironmentCached);
      const folder = path.join(root, 'projects', '-host-selected'); await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, 'selected-last.jsonl');
      const result = (duration_ms: number, total_cost_usd: number) => JSON.stringify({ type: 'result', duration_ms, total_cost_usd });
      const filler = JSON.stringify({ type: 'user', message: 'PRIVATE_HISTORY_TEXT'.repeat(512) });
      const text = [result(1000, 10), ...(mode === 'truncated' ? Array(400).fill(filler) : []), result(0, 0), ''].join('\n');
      await fs.writeFile(file, text); const before = await fs.stat(file); const entries = await fs.readdir(folder);
      const { ClaudeCodeProvider } = await vi.importActual<typeof import('../orchestrators/claude-code-provider')>('../orchestrators/claude-code-provider');
      const provider = new ClaudeCodeProvider();
      const originalLookup = provider.transcriptPath.bind(provider);
      const lookup = vi.spyOn(provider, 'transcriptPath').mockImplementation(async (...args) => { const selected = await originalLookup(...args); shell.invalidateShellEnvironmentCache(); return selected; }); const nativeRead = vi.spyOn(provider, 'readSessionTranscript');
      m.catalog.mockReturnValue(provider);
      m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] }, project });
      const c = (await read()).cards.find((c) => c.id === 'session')!;
      expect(lookup).toHaveBeenCalledWith('selected-last', '/host/selected', expect.objectContaining({ passiveLookup: true, maxBytes: 2097152 })); expect(m.transcript).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled(); expect(shell.isShellEnvironmentCached()).toBe(false);
      expect(nativeRead).toHaveBeenCalledTimes(1); const options = nativeRead.mock.calls[0][2]!;
      expect(options.maxBytes).toBe(2097152); expect(options.stats?.fileBytes).toBe(Buffer.byteLength(text));
      expect(options.stats?.bytesRead).toBeLessThanOrEqual(2097152);
      expect(c.notes.join(' ')).toContain(mode === 'truncated' ? 'truncated' : 'complete file');
      if (mode === 'truncated') { expect(Buffer.byteLength(text)).toBeGreaterThan(2097152); expect(options.stats?.truncated).toBe(true); }
      expect(c.rows).toContainEqual({ label: 'Duration', value: '0s' }); expect(c.rows).toContainEqual({ label: 'Cost', value: '$0.00' });
      expect(c.rows.some((r) => r.label === 'Ended')).toBe(false); expect(JSON.stringify(c)).not.toContain('PRIVATE_HISTORY_TEXT');
      expect(await fs.readFile(file, 'utf8')).toBe(text); expect(await fs.readdir(folder)).toEqual(entries);
      const after = await fs.stat(file); expect({ size: after.size, mtimeMs: after.mtimeMs, ino: after.ino }).toEqual({ size: before.size, mtimeMs: before.mtimeMs, ino: before.ino });
    } finally { Object.defineProperty(process, 'platform', { value: platform }); shell.invalidateShellEnvironmentCache(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(['inventory', 'revocation'] as const)('withholds historical evidence after awaited %s change with real primary witness', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-history-witness-'));
    try {
      m.realWitness = true; m.base = path.join(root, 'profile'); const home = path.join(root, 'home');
      await fs.mkdir(m.base); await fs.mkdir(path.join(home, '.clubhouse'), { recursive: true });
      const selected = { ...agent(), worktreePath: home, lastSessionId: 'selected-last', sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'claude-code' }] };
      const selectedProject = { ...project, path: home }; const file = path.join(home, '.clubhouse', 'agents.json');
      await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [selectedProject] })); await fs.writeFile(file, JSON.stringify([selected]));
      m.target.mockResolvedValue({ agent: selected, project: selectedProject }); let allowed = true;
      const transcript = async () => {
        if (mode === 'inventory') await fs.writeFile(file, JSON.stringify([{ ...selected, sessionHistory: [{ sessionId: 'selected-last', orchestrator: 'codex-cli' }] }])); else allowed = false;
        return [{ type: 'result', total_cost_usd: 42 }];
      };
      m.historical.mockImplementation(transcript); m.transcript.mockImplementation(transcript);
      const response = await readRemoteAgentDetails('a1', () => allowed);
      expect(response.status).toBe(mode === 'inventory' ? 409 : 403); expect(response.body).not.toHaveProperty('cards');
      expect(m.historical).toHaveBeenCalledTimes(1); expect(m.transcript).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('distinguishes verified empty, per-section error and explicit bounded omissions', async () => {
    m.actions.mockImplementation(() => { throw new Error('PRIVATE_ERROR'); });
    m.canvases.mockResolvedValue(Array.from({ length: 112 }, (_, i) => ({ name: `Board ${i}`, scope: 'project' })));
    const value = await read();
    expect(value.cards.find((c) => c.id === 'actions')).toMatchObject({ state: 'error', rows: [] });
    expect(value.cards.find((c) => c.id === 'connections')).toMatchObject({ state: 'ok', rows: [], summary: '0 directions' });
    expect(value.cards.find((c) => c.id === 'canvases')).toMatchObject({ state: 'ok', omitted: 12 });
    expect(JSON.stringify(value)).not.toContain('PRIVATE_ERROR');
  });
  it('rejects aliases/disposed agents and rechecks authority after awaited work', async () => {
    m.target.mockResolvedValueOnce({ agent: { ...agent(), id: 'other' }, project });
    expect((await readRemoteAgentDetails('a1', () => true)).status).toBe(404);
    expect(m.provider).not.toHaveBeenCalled();
    let allowed = true;
    m.provider.mockImplementation(async () => { allowed = false; return { id: 'codex-cli' }; });
    expect((await readRemoteAgentDetails('a1', () => allowed)).status).toBe(403);
    expect(m.settings).not.toHaveBeenCalled();
  });
  it('rejects late results after revocation and never returns partial private host data', async () => {
    let allowed = true;
    m.canvases.mockImplementation(async () => { allowed = false; return [{ name: 'PRIVATE_BOARD', scope: 'project' }]; });
    const response = await readRemoteAgentDetails('a1', () => allowed);
    expect(response.status).toBe(403); expect(JSON.stringify(response)).not.toContain('PRIVATE_BOARD');
    expect(m.branch).not.toHaveBeenCalled();
  });
  it('does not claim an earlier run’s retained MCP handshake or tool count is current', async () => {
    m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'pty', nonce: 'run-a' });
    noteAgentStarting('a1');
    m.connection.mockReturnValue({ connectedAt: 1, toolCount: 999 });
    let value = await read();
    let evidence = value.cards.find((c) => c.id === 'skills-mcp')!;
    expect(JSON.stringify(evidence)).not.toContain('999 tools');
    expect(JSON.stringify(evidence)).not.toContain('Connected');
    m.connection.mockReturnValue({ connectedAt: Date.now() + 1, toolCount: 12, current: true });
    value = await read(); evidence = value.cards.find((c) => c.id === 'skills-mcp')!;
    expect(JSON.stringify(evidence)).toContain('12 tools');
    _resetAgentDisplayStateForTesting();
    // Matching bridge auth identity proves the run even if lifecycle time is unknown.
    expect(JSON.stringify((await read()).cards.find((c) => c.id === 'skills-mcp'))).toContain('12 tools');
    m.running.mockReturnValue(false);
    expect(JSON.stringify((await read()).cards.find((c) => c.id === 'skills-mcp'))).not.toContain('Connected');
  });
  it('shares helper counters/work words, skips inapplicable checks and makes the work bound explicit', async () => {
    const helpers = Array.from({ length: 10 }, (_, i) => ({ projectPath: project.path, config: { ...agent(), id: `h${i}`, name: `Helper ${i}`, parentAgentId: 'a1' } }));
    helpers.push({ projectPath: project.path, config: { ...agent(), id: 'starting', name: 'Starting helper', parentAgentId: 'a1', creation: { state: 'creating' } } } as never);
    helpers.push({ projectPath: project.path, config: { ...agent(), id: 'disposed', name: 'Disposed helper', parentAgentId: 'a1', disposedAt: '2026-11-19' } } as never);
    m.helpers.mockResolvedValue(helpers);
    m.work.mockResolvedValueOnce({ dirty: 2, unpushed: 150, unmerged: 0 }).mockResolvedValueOnce({ dirty: 0, unpushed: 0, unmerged: null, error: 'unknown' });
    const c = (await read()).cards.find((c) => c.id === 'orchestrate')!;
    expect(c.rows).toContainEqual({ label: 'Helpers', value: '11 · 1 starting' });
    expect(c.rows).toContainEqual({ label: 'Disposed helpers', value: '1' });
    expect(c.rows.find((r) => r.label === 'Helper 0')?.value).toContain('2 uncommitted, 99+ unpushed');
    expect(c.rows.find((r) => r.label === 'Helper 1')?.value).toContain('couldn’t check');
    expect(c.rows.find((r) => r.label === 'Helper 2')?.value).toContain('clean');
    expect(c.rows.find((r) => r.label === 'Helper 8')?.value).toContain('Work not checked');
    expect(c.notes.join(' ')).toContain('2 helper work checks omitted');
    expect(m.work).toHaveBeenCalledTimes(8);
    expect(m.work.mock.calls.every((call) => call[0].agent.id === 'a1' && call[1].config.parentAgentId === 'a1')).toBe(true);
  });
  it('keeps disposed and live handed-off helpers distinct with their real timestamps', async () => {
    m.helpers.mockResolvedValue([{ projectPath: project.path, config: { ...agent(), id: 'disposed', name: 'Disposed helper', disposedAt: '2026-11-18T12:00:00Z' } }, { projectPath: project.path, config: { ...agent(), id: 'handoff', name: 'Handed helper', handoff: { at: '2026-11-19' } } }]);
    const rows = (await read()).cards.find((c) => c.id === 'orchestrate')!.rows;
    expect(rows.find((r) => r.label === 'Disposed helper')?.value).toContain('Disposed · feature · 2026-11-18T12:00:00Z');
    expect(rows.find((r) => r.label === 'Handed helper')?.value).toContain('Handed off');
  });
  it.each([1024, 1025, 2048])('keeps nested Settings valid for a %i-character MCP name', async (length) => {
    m.mcp.mockResolvedValue([{ name: 'a'.repeat(length) }]);
    const value = await read();
    expect(value.settings?.setup.mcps?.[0].length).toBeLessThanOrEqual(1024);
    if (length > 1024) expect(value.settings?.setup.mcps?.[0]).toContain('[text truncated]');
  });
  it('keeps unreadable global MCP config unknown, preserving other independent cards', async () => {
    m.mcp.mockRejectedValue(new Error('unreadable-global'));
    const value = await read();
    expect(value.cards.find((c) => c.id === 'settings')?.state).toBe('error');
    expect(value.settings?.setup.mcps).toBeNull();
    expect(JSON.stringify(value)).not.toContain('0 configured');
    expect(value.cards.find((c) => c.id === 'connections')?.state).toBe('ok');
  });
  it('accepts a stable registered PTY using the real resolver despite new facade objects per lookup', async () => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'pty', orchestrator: 'codex-cli', nonce: 'run-a' });
    const resolver = await import('./agent-runtime');
    expect(resolver.getAgentRuntime('a1')).not.toBe(resolver.getAgentRuntime('a1'));
    expect((await read()).running).toBe(true);
  });
  it.each(['pty', 'headless'] as const)('refuses a %s registration replacement across an awaited section', async (runtime) => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime, orchestrator: 'codex-cli', nonce: 'run-a' });
    m.canvases.mockImplementation(async () => { m.registration.mockReturnValue({ cwd: '/host/selected', runtime, orchestrator: 'codex-cli', nonce: 'run-b' }); return []; });
    expect(await readRemoteAgentDetails('a1', () => true)).toMatchObject({ status: 409, body: { error: 'agent_run_changed' } });
  });
  it('refuses stopped headless/PTY evidence across an awaited section', async () => {
    m.useRealRuntime = true; m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ cwd: '/host/selected', runtime: 'headless', nonce: 'run-a' });
    m.canvases.mockImplementation(async () => { m.running.mockReturnValue(false); m.registration.mockReturnValue(undefined); return []; });
    expect((await readRemoteAgentDetails('a1', () => true)).status).toBe(409);
  });
});
