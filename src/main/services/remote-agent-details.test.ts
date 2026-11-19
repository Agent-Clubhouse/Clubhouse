import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { noteAgentStarting, _resetAgentDisplayStateForTesting } from './agent-display-state';
import { ORCHESTRATION_DEFAULTS } from '../../shared/orchestration-policy';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const m = vi.hoisted(() => ({ target: vi.fn(), settings: vi.fn(), provider: vi.fn(), running: vi.fn(), policies: vi.fn(), helpers: vi.fn(), requests: vi.fn(), bindings: vi.fn(), sources: vi.fn(), satellite: vi.fn(), peer: vi.fn(), directions: vi.fn(), dispatcher: vi.fn(), dispatcherOn: vi.fn(), agentCard: vi.fn(), actions: vi.fn(), canvases: vi.fn(), status: vi.fn(), entries: vi.fn(), template: vi.fn(), mcp: vi.fn(), branch: vi.fn(), transcript: vi.fn(), connection: vi.fn(), work: vi.fn(), realWitness: false, base: '', registration: vi.fn(), runtime: vi.fn(), useRealRuntime: false }));
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
vi.mock('../orchestrators', () => ({ isSessionCapable: () => true }));
vi.mock('./session-reader', () => ({ normalizeSessionEvents: (x: unknown) => x, buildSessionSummary: () => ({ totalDurationMs: 5000, totalCostUsd: 1.25, lastActiveAt: '2026-11-19T00:00:00Z' }), SUMMARY_TRANSCRIPT_MAX_BYTES: 2097152 }));
import { readRemoteAgentDetails } from './remote-agent-details';
const agent = () => ({ id: 'a1', name: 'Selected', color: 'blue', createdAt: '2026-11-18', worktreePath: '/host/selected', branch: 'feature' });
const project = { id: 'p1', name: 'Project', path: '/host/project' };
const setting = () => ({ version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', model: 'model', runtime: 'terminal', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: null } });
beforeEach(() => {
  _resetAgentDisplayStateForTesting();
  m.realWitness = false; m.useRealRuntime = false; m.registration.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined);
  m.target.mockResolvedValue({ agent: agent(), project });
  m.settings.mockResolvedValue({ status: 200, body: setting() });
  m.provider.mockResolvedValue({ id: 'codex-cli', conventions: {}, readSessionTranscript: m.transcript });
  m.transcript.mockResolvedValue([]);
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
    m.target.mockResolvedValue({ agent: { ...agent(), lastSessionId: 'selected-last' }, project });
    const value = await read();
    expect(m.transcript).toHaveBeenCalledWith('selected-last', '/host/selected', { maxBytes: 2097152 });
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Cost', value: '$1.25' });
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
