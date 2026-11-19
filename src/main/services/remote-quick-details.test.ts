import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { beginQuickAgentRun, clearQuickAgentRuns, finishQuickAgentRun, noteQuickAgentRuntime } from './quick-agent-events';
import type { AgentRegistration } from './agent-registry';
import { noteAgentStarting, _resetAgentDisplayStateForTesting } from './agent-display-state';
import { resolveReadOnlyQuickTarget } from './read-only-quick-target';
import { projectActionDetails } from './actions/details-read';
import { readRemoteQuickDetails } from './remote-quick-details';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../shared/remote-agent-details';
import { readRemoteAgentChanges } from './remote-agent-changes';
import { isRemoteAgentChanges } from '../../shared/remote-agent-changes';
import * as repository from './read-only-repository-changes';
const m = vi.hoisted(() => ({ base: '', durable: vi.fn(), registration: vi.fn(), runtime: vi.fn(), running: vi.fn(), bindings: vi.fn(), sources: vi.fn(), satellite: vi.fn(), peer: vi.fn(), directions: vi.fn(), actions: vi.fn(), canvases: vi.fn(), template: vi.fn(), entries: vi.fn(), connection: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.registration } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: m.runtime }));
vi.mock('./agent-system', () => ({ isAgentRunning: m.running }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.durable }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => ({ displayName: `Host ${id}` }) }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: m.bindings } }));
vi.mock('./annex-client', () => ({ getSatellite: m.satellite }));
vi.mock('./annex-peers', () => ({ getPeer: m.peer }));
vi.mock('./connection-sources', () => ({ listConnectionSources: m.sources }));
vi.mock('./connection-grants-store', () => ({ listConnectionDirectionsForInspection: m.directions }));
vi.mock('./actions', async () => ({ readActionDetailsForAgent: (agentId: string, projectId: string, dispatcher: boolean, names: import('../../shared/actions').ActionNames) => projectActionDetails({ list: m.actions, lastRunForDisplay: (id: string) => m.actions().find((a: { id: string }) => a.id === id)?.lastRun }, agentId, projectId, dispatcher, names), actionNames: () => ({ agent: () => 'Quick', project: () => 'Project' }) }));
vi.mock('./canvas-store-reader', () => ({ getAgentCanvasMemberships: m.canvases }));
vi.mock('./clubhouse-mcp/bridge-server', () => ({ getAgentConnection: m.connection, getCurrentAgentConnection: () => m.connection()?.current ? m.connection() : null }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ getTemplate: m.template, liveEntries: m.entries }) }));
let root: string, project: string;
async function snapshot(folder: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name), relative = prefix + item.name;
    if (item.isDirectory()) Object.assign(out, await snapshot(file, relative + '/'));
    else out[relative] = (await fs.readFile(file)).toString('base64');
  }
  return out;
}
const start = () => beginQuickAgentRun({ agentId: 'quick', projectPath: project, cwd: project, name: 'Review', model: 'launch-model', effort: 'high', orchestrator: 'codex-cli', managedTemplate: { id: 't1', agentName: 'Review', addParts: ['added'], removeParts: ['removed'] } });
beforeEach(async () => {
  clearQuickAgentRuns(); _resetAgentDisplayStateForTesting();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-quick-details-')); m.base = path.join(root, 'profile'); project = path.join(root, 'project');
  await fs.mkdir(m.base); await fs.mkdir(project);
  await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Project', path: project }] }));
  m.registration.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined); m.running.mockReturnValue(false);
  m.bindings.mockReturnValue([]); m.sources.mockResolvedValue({ pairs: [], unreadable: [] }); m.satellite.mockReturnValue(null); m.peer.mockReturnValue(undefined); m.directions.mockReturnValue([]);
  m.actions.mockReturnValue([]); m.canvases.mockResolvedValue([]); m.connection.mockReturnValue(null);
  m.template.mockResolvedValue({ name: 'Review template' }); m.entries.mockResolvedValue({ added: { name: 'Extra' }, removed: { name: 'Tone' } });
  m.durable.mockImplementation(() => { throw new Error('Quick reads must not resolve a durable config.'); });
});
afterEach(async () => { vi.restoreAllMocks(); clearQuickAgentRuns(); await fs.rm(root, { recursive: true, force: true }); });
const read = async () => {
  const target = await resolveReadOnlyQuickTarget('quick', () => true);
  expect(target).not.toBeNull();
  const result = await readRemoteQuickDetails(target!, () => true);
  expect(result.status).toBe(200); expect(isRemoteAgentDetails(result.body, 'quick')).toBe(true);
  return result.body as RemoteAgentDetails;
};
describe('read-only quick Details target and cards', () => {
  it('uses the shared selected quick-agent action groups without exposing action definitions or another run', async () => {
    start();
    const related = { id: 'reminder', name: 'Quick reminder', owner: { kind: 'agent', agentId: 'quick' }, enabled: false, trigger: { kind: 'once', at: 1000 }, steps: [{ kind: 'message', agentId: 'quick', text: 'PRIVATE_PROMPT' }], lastRun: { outcome: 'done', startedAt: 1000, reason: 'PRIVATE_RUN_REASON' } };
    m.actions.mockReturnValue([related, { ...related, id: 'other', name: 'PRIVATE_OTHER_ACTION', owner: { kind: 'agent', agentId: 'other' }, steps: [{ kind: 'wake', agentId: 'other' }] }]);
    const c = (await read()).cards.find((c) => c.id === 'actions')!;
    expect(c.summary).toBe('1 related'); expect(c.rows.map((r) => r.action?.group)).toEqual(['owned', 'targeting']);
    expect(c.rows[0].action).toMatchObject({ enabled: false, lastRun: { outcome: 'done', startedAt: 1000 } }); expect(JSON.stringify(c)).not.toContain('PRIVATE_'); expect(m.durable).not.toHaveBeenCalled();
  });
  it('shows retained launch choices without creating a durable config or pretending the requested provider is running', async () => {
    start(); noteAgentStarting('quick', true);
    const before = await snapshot(root), result = await read();
    expect(result).toMatchObject({ running: false, status: 'spawning', providerId: 'unknown', settings: null });
    const c = result.cards.find((c) => c.id === 'settings')!;
    expect(c.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    expect(c.rows).toContainEqual({ label: 'Requested effort', value: 'high' });
    expect(c.rows).toContainEqual({ label: 'Template', value: 'Review template' });
    expect(c.rows).toContainEqual({ label: 'Added for this run', value: 'Extra' });
    expect(c.rows).toContainEqual({ label: 'Left out for this run', value: 'Tone' });
    expect(result.cards.find((c) => c.id === 'orchestrate')?.state).toBe('not-applicable');
    expect(result.cards.find((c) => c.id === 'dispatcher')?.state).toBe('not-applicable');
    expect(await snapshot(root)).toEqual(before);
    expect(await resolveReadOnlyQuickTarget('Review', () => true)).toBeNull();
  });
  it('uses actual registration for runtime/provider and authenticated current-run MCP evidence', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'claude-code', runtime: 'pty', nonce: 'run-a', launchAccess: { access: 'ask', freeAgentMode: false } };
    m.running.mockReturnValue(true); m.registration.mockReturnValue(registration);
    noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    m.runtime.mockImplementation(() => ({ kind: 'pty' })); // Facade identity is not a run identity.
    m.connection.mockReturnValue({ connectedAt: 1, toolCount: 999 });
    let value = await read();
    expect(value.providerId).toBe('claude-code');
    expect(value.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'CLI', value: 'Host claude-code' });
    expect(JSON.stringify(value)).not.toContain('999 tools');
    m.connection.mockReturnValue({ current: true, connectedAt: Date.now(), toolCount: 12 });
    value = await read(); expect(JSON.stringify(value)).toContain('12 tools');
  });
  it('does not adopt a prior runtime for a reused ID or its current nonce/handshake/cwd', async () => {
    start(); m.running.mockReturnValue(true);
    m.registration.mockReturnValue({ projectPath: project, cwd: '/PRIVATE_PRIOR_FOLDER', orchestrator: 'prior-cli', runtime: 'pty', nonce: 'prior-run' });
    m.runtime.mockReturnValue({ kind: 'chat', getSessionId: () => 'PRIVATE_PRIOR_SESSION' });
    m.connection.mockReturnValue({ current: true, toolCount: 999 });
    const value = await read();
    expect(value).toMatchObject({ running: false, status: 'spawning', providerId: 'unknown', sessionId: null });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_PRIOR|prior-cli|999 tools/);
    expect(value.cards.find((c) => c.id === 'session')?.rows).toContainEqual({ label: 'Requested folder', value: project });
    expect((await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true)).status).toBe(409);
  });
  it('retains safe observed runtime metadata historically after the exact runtime is untracked', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'actual-cli', runtime: 'headless', nonce: 'PRIVATE_AUTH_NONCE' };
    m.registration.mockReturnValue(registration);
    noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
    m.registration.mockReturnValue(undefined); finishQuickAgentRun(run, 'completed');
    const value = await read();
    expect(value).toMatchObject({ running: false, providerId: 'actual-cli', sessionId: null, status: 'sleeping' });
    expect(value.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'Last runtime', value: 'CLI (headless)' });
    expect(JSON.stringify(value)).not.toContain('PRIVATE_AUTH_NONCE');
    expect(JSON.stringify(run)).not.toContain('PRIVATE_AUTH_NONCE');
  });
  it('withholds runtime evidence for a failed launch even if another registration remains live', async () => {
    const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: '/PRIVATE_OLD_CWD', orchestrator: 'old-cli', runtime: 'pty', nonce: 'old' };
    finishQuickAgentRun(run, 'failed'); m.registration.mockReturnValue(registration); m.running.mockReturnValue(true);
    noteQuickAgentRuntime(run, registration, () => true); // A late observation cannot adopt a finished/replaced launch.
    const value = await read();
    expect(value).toMatchObject({ running: false, status: 'error', providerId: 'unknown' });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_OLD_CWD|old-cli/);
  });
  it('keeps missing templates and unreadable connection sources partial, never verified empty', async () => {
    start(); m.template.mockRejectedValue(new Error('PRIVATE_ERROR'));
    m.sources.mockResolvedValue({ pairs: [], unreadable: ['Host source'] });
    const result = await read();
    expect(result.cards.find((c) => c.id === 'settings')?.rows).toContainEqual({ label: 'Requested model', value: 'launch-model' });
    const connections = result.cards.find((c) => c.id === 'connections')!;
    expect(connections.state).toBe('error'); expect(connections.summary).toContain('incomplete');
    expect(connections.notes.join(' ')).not.toContain('No Clubhouse MCP wires');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR');
  });
  it.each(['replacement', 'finished', 'project-removed', 'nonce-changed', 'revoked'] as const)('withholds late quick evidence after %s', async (condition) => {
    const run = start(); let allowed = true;
    const registration = { cwd: project, orchestrator: 'codex-cli', runtime: 'pty', nonce: 'run-a' };
    m.registration.mockReturnValue(registration);
    const target = await resolveReadOnlyQuickTarget('quick', () => allowed);
    m.canvases.mockImplementation(async () => {
      if (condition === 'replacement') start();
      if (condition === 'finished') finishQuickAgentRun(run, 'completed');
      if (condition === 'project-removed') await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      if (condition === 'nonce-changed') registration.nonce = 'run-b';
      if (condition === 'revoked') allowed = false;
      return [{ name: 'PRIVATE_LATE_BOARD', scope: 'app', canvasId: 'c', viewId: 'v' }];
    });
    const response = await readRemoteQuickDetails(target!, () => allowed);
    expect(response.status).toBe(condition === 'revoked' ? 403 : 409);
    expect(response.body).not.toHaveProperty('cards');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_LATE_BOARD');
  });
});

async function quickRepository() {
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }, (error, out) => error ? reject(error) : resolve(out.trim())));
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@invalid');
  await fs.writeFile(path.join(project, '.gitattributes'), '* -filter -ident -text\n'); await fs.writeFile(path.join(project, 'source.txt'), 'before\n');
  await git('add', '.'); await git('commit', '-m', 'base'); await git('switch', '-c', 'feature');
  await fs.writeFile(path.join(project, 'source.txt'), 'after\n');
  // The Git/filesystem comparison is real; the already-created runtime is modeled.
  const run = start(); const registration: AgentRegistration = { projectPath: project, cwd: project, orchestrator: 'codex-cli', runtime: 'pty', nonce: 'created-run' };
  m.registration.mockReturnValue(registration);
  noteQuickAgentRuntime(run, registration, () => m.registration() === registration);
  return git;
}
describe('quick Changes with actual inventories and Git', () => {
  it('does not read a requested cwd from an unconfirmed/failed launch', async () => {
    const run = beginQuickAgentRun({ agentId: 'quick', name: 'Failed', projectPath: project, cwd: path.join(root, 'unconfirmed-folder') });
    finishQuickAgentRun(run, 'failed');
    const readRoot = vi.spyOn(repository, 'readOnlyRepositoryRoot');
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(200); expect(result.body).toHaveProperty('state', 'unsupported');
    expect(readRoot).not.toHaveBeenCalled(); expect(m.durable).not.toHaveBeenCalled();
  });
  it('reads branch metadata and patches without a durable fallback or repository writes', async () => {
    const git = await quickRepository();
    await git('update-ref', 'refs/clubhouse/checkpoints/quick/old-session/old-turn/start', 'HEAD');
    const before = await snapshot(root);
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(200); expect(isRemoteAgentChanges(result.body, 'quick', { scope: 'branch' })).toBe(true);
    const body = result.body as { files: Array<{ fileKey: string; path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['source.txt']);
    const patch = await readRemoteAgentChanges('quick', { scope: 'branch', fileKey: body.files[0].fileKey }, () => true);
    expect(JSON.stringify(patch)).toContain('+after');
    const historical = await readRemoteAgentChanges('quick', { scope: 'session' }, () => true);
    expect(historical.body).toHaveProperty('state', 'unsupported');
    expect(m.durable).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });
  it.each(['project-removed', 'replacement'] as const)('withholds an actual quick comparison after %s during the comparison await', async (condition) => {
    await quickRepository();
    const actual = repository.readOnlyRepositoryChanges;
    vi.spyOn(repository, 'readOnlyRepositoryChanges').mockImplementation(async (...args) => {
      const value = await actual(...args);
      if (condition === 'replacement') start();
      else await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      return value;
    });
    const result = await readRemoteAgentChanges('quick', { scope: 'branch' }, () => true);
    expect(result.status).toBe(409); expect(result.body).not.toHaveProperty('files');
    expect(m.durable).not.toHaveBeenCalled();
  });
});
