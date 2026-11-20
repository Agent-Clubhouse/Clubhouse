import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ base: '', target: vi.fn(), work: vi.fn(), running: new Set<string>(), registrations: new Map<string, { projectPath: string; cwd?: string; runtime: string }>(), runtimes: new Map<string, { kind: string; getState(): string }>() }));
vi.mock('../orchestrators', () => ({ getProvider: vi.fn() }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./clubhouse-mcp/orchestration-gate', () => ({ setOrchestrationEnabled: vi.fn() }));
vi.mock('./clubhouse-mcp/dispatcher-gate', () => ({ setDispatcherAgent: vi.fn() }));
vi.mock('./clubhouse-mcp/mcp-call-gate', () => ({ forgetMcpCaller: vi.fn() }));
vi.mock('./managed-agents/delivery-records', () => ({ dropRunningSnapshot: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
vi.mock('./read-only-helper-work', () => ({ readOnlyHelperWork: m.work }));
vi.mock('./agent-system', () => ({ isAgentRunning: (id: string) => m.running.has(id) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (id: string) => m.registrations.get(id) } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: (id: string) => m.runtimes.get(id) }));
vi.mock('./project-store', () => ({ peekProjectsChecked: async () => ({ readable: true, projects: JSON.parse(await fs.readFile(path.join(m.base, 'projects.json'), 'utf8')).projects }) }));
import type { AgentConfigTarget } from './agent-config-reader';
import type { HelperEntry } from './helper-index';
import { captureReadOnlyAgentTargetWitness, captureReadOnlyAgentInventoryWitness } from './read-only-agent-target-witness';
import { readSelectedHelperPage } from './selected-helper-page';
import { isRemoteHelperPage } from '../../shared/remote-helper-page';
import { noteAgentWakeFailed, _resetAgentDisplayStateForTesting } from './agent-display-state';
let root: string, home: string, other: string, parent: AgentConfigTarget, helpers: HelperEntry[];
const file = (folder: string) => path.join(folder, '.clubhouse', 'agents.json');
const requests = { state: 'ok' as const, value: [], inputs: [] };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'selected-helper-page-'))); m.base = root; home = path.join(root, 'home'); other = path.join(root, 'other');
  await fs.mkdir(path.join(home, '.clubhouse'), { recursive: true }); await fs.mkdir(path.join(other, '.clubhouse'), { recursive: true });
  const p = { id: 'parent-project', name: 'Same basename', displayName: 'Parent display', path: home }, q = { id: 'helper-project', name: 'Same basename', displayName: 'Helper display', path: other };
  parent = { project: p, agent: { id: 'parent', name: 'Selected', color: 'blue', createdAt: '2026-11-20' } };
  helpers = Array.from({ length: 101 }, (_, i) => ({ projectPath: other, config: { id: `helper-${i}`, name: `Helper ${i}`, parentAgentId: 'parent', parentProjectPath: home, color: 'blue', createdAt: '2026-11-20', branch: 'feature', instructions: 'PRIVATE_INSTRUCTIONS' } }));
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [p, q] })); await fs.writeFile(file(home), JSON.stringify([parent.agent])); await fs.writeFile(file(other), JSON.stringify(helpers.map((h) => h.config)));
  m.target.mockImplementation(async (id: string, project: unknown, options: unknown) => { expect(project).toBeUndefined(); expect(options).toEqual({ strict: true }); const matches = JSON.parse(await fs.readFile(file(other), 'utf8')).filter((h: HelperEntry['config']) => h.id === id); if (matches.length !== 1) throw new Error('PRIVATE_LOOKUP'); return { project: q, agent: matches[0] }; });
  m.work.mockResolvedValue({ dirty: 2, unpushed: 150, unmerged: null }); m.running.clear(); m.registrations.clear(); m.runtimes.clear(); _resetAgentDisplayStateForTesting();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const read = (offset = 0, entries: HelperEntry[] | undefined = helpers, authorized = () => true, pending: import('./display-settings').DisplayValue<import('./helper-start-requests').HelperStartRequestDisplay[]> = requests) => {
  const receipts = [captureReadOnlyAgentTargetWitness(parent), captureReadOnlyAgentInventoryWitness(other, helpers.map((h) => h.config))];
  return readSelectedHelperPage(parent, entries, pending, { offset, authorized, target: receipts[0], receipts }).then((page) => ({ page, receipts }));
};
it('reaches the 101st selected helper with at most eight qualified work reads per page and no raw paths/errors', async () => {
  const first = await read(); expect(isRemoteHelperPage(first.page)).toBe(true); expect(first.page).toMatchObject({ total: 101, liveCount: 101, disposedCount: 0, pendingCount: 0, next: 8 });
  expect(first.page.rows).toHaveLength(8); expect(m.work).toHaveBeenCalledTimes(8); expect(first.page.rows[0]).toMatchObject({ name: 'Helper 0', projectName: 'Helper display', status: 'not-running', failure: 'unknown', work: { state: 'recorded', text: '2 uncommitted, 99+ unpushed' }, target: { agentId: 'helper-0', projectId: 'helper-project' } });
  m.work.mockClear(); const last = await read(96); expect(last.page.rows.map((r) => r.name)).toEqual(['Helper 96', 'Helper 97', 'Helper 98', 'Helper 99', 'Helper 100']); expect(last.page.next).toBeNull(); expect(m.work).toHaveBeenCalledTimes(5);
  expect(first.receipts.every((r) => r.current())).toBe(true); expect(JSON.stringify(last.page)).not.toMatch(/PRIVATE_|projectPath|parentProjectPath|command|instructions/); expect(JSON.stringify(last.page)).not.toContain(root);
});
it('separates current-run needs-you/failure from unbound native-ID observations', async () => {
  for (const id of ['helper-0', 'helper-1']) { m.running.add(id); m.registrations.set(id, { projectPath: other, cwd: other, runtime: 'chat' }); }
  m.runtimes.set('helper-0', { kind: 'chat', getState: () => 'waiting_permission' }); m.runtimes.set('helper-1', { kind: 'chat', getState: () => 'error' });
  noteAgentWakeFailed('helper-2', new Error('PRIVATE_CLI_FAILURE'));
  const { page, receipts } = await read(); expect(page.rows[0]).toMatchObject({ status: 'needs-you', statusSource: 'current-run' }); expect(page.rows[1]).toMatchObject({ status: 'failed', failure: 'runtime' }); expect(page.rows[2]).toMatchObject({ status: 'not-running', failure: 'unknown', statusSource: 'unknown' });
  m.runtimes.set('helper-0', { kind: 'chat', getState: () => 'running' }); expect(receipts.some((r) => !r.current())).toBe(true); expect(JSON.stringify(page)).not.toContain('PRIVATE_');
});
it('captures disposed/creating/handoff counts and pending state independently of work and runtime', async () => {
  Object.assign(helpers[0].config, { disposedAt: '2026-11-20T00:00:00Z' }); Object.assign(helpers[1].config, { creation: { state: 'creating' } }); Object.assign(helpers[2].config, { handoff: { at: '2026-11-20' } });
  await fs.writeFile(file(other), JSON.stringify(helpers.map((h) => h.config)));
  const { page } = await read(0, helpers, () => true, { state: 'unavailable', reason: 'unreadable', inputs: [] });
  expect(page).toMatchObject({ liveCount: 100, disposedCount: 1, pendingCount: null, pending: [] }); expect(page.rows[0]).toMatchObject({ status: 'disposed', disposedAt: '2026-11-20T00:00:00Z', projectName: 'Helper display' }); expect(page.rows[0].target).toBeUndefined(); expect(page.rows[1].status).toBe('creating'); expect(page.rows[2].status).toBe('handed-off'); expect(m.work).toHaveBeenCalledTimes(6);
});
it('does not turn identity/work failures or an unavailable inventory into empty/clean facts', async () => {
  m.target.mockRejectedValueOnce(new Error('PRIVATE_IDENTITY')); m.work.mockResolvedValueOnce({ dirty: 0, unpushed: 0, unmerged: null, error: 'PRIVATE_GIT' });
  const { page } = await read(); expect(page.rows[0]).toMatchObject({ projectName: null, status: 'unknown', work: { state: 'unavailable', reason: 'identity' } }); expect(page.rows[0].target).toBeUndefined(); expect(page.rows[1].work).toEqual({ state: 'unavailable', reason: 'read-failed' });
  const missing = await readSelectedHelperPage(parent, undefined, requests, { offset: 0, authorized: () => true, target: captureReadOnlyAgentTargetWitness(parent), receipts: [] }); expect(missing).toMatchObject({ state: 'unavailable', total: null, liveCount: null, disposedCount: null, pendingCount: 0 }); expect(isRemoteHelperPage(missing)).toBe(true);
});
it('retains parent/helper inventory and runtime currentness across awaits with revocation precedence', async () => {
  let allowed = true; m.work.mockImplementationOnce(async () => { allowed = false; return { dirty: 0, unpushed: 0, unmerged: null }; });
  await expect(read(0, helpers, () => allowed)).rejects.toThrow();
  m.work.mockResolvedValue({ dirty: 0, unpushed: 0, unmerged: null }); const { receipts } = await read();
  await fs.writeFile(file(other), JSON.stringify(helpers.map((h, i) => i === 0 ? { ...h.config, parentAgentId: 'another' } : h.config))); expect(receipts.some((r) => !r.current())).toBe(true);
});
it.each([-8, 1, 4097, 8.1])('refuses malformed or unbounded helper page offset %s', async (offset) => { await expect(read(offset)).rejects.toThrow(); expect(m.work).not.toHaveBeenCalled(); });

it.each(['nonce', 'provider', 'runtime', 'project', 'cwd', 'run'] as const)('invalidates immutable helper run identity after actual in-place %s mutation', async (mode) => {
  const actual = await vi.importActual<typeof import('./agent-registry')>('./agent-registry');
  const facade = await import('./agent-registry');
  const get = vi.spyOn(facade.agentRegistry, 'get').mockImplementation((id) => actual.agentRegistry.get(id));
  const registration: import('./agent-registry').AgentRegistration = { projectPath: other, cwd: other, runtime: 'chat', orchestrator: 'codex-cli', nonce: 'before' };
  let run = 'before'; const runtime = { kind: 'chat', getState: () => 'idle', getSessionId: () => run, getNativeSessionId: () => 'native', getDisplayRunId: () => run };
  actual.agentRegistry.register('helper-0', registration); m.running.add('helper-0'); m.runtimes.set('helper-0', runtime);
  try {
    const { receipts } = await read(); expect(receipts.every((r) => r.current())).toBe(true);
    if (mode === 'nonce') actual.agentRegistry.setNonce('helper-0', 'after');
    if (mode === 'runtime') actual.agentRegistry.setRuntime('helper-0', 'pty');
    if (mode === 'provider') registration.orchestrator = 'claude-code';
    if (mode === 'project') registration.projectPath = home;
    if (mode === 'cwd') registration.cwd = home;
    if (mode === 'run') run = 'after';
    expect(actual.agentRegistry.get('helper-0')).toBe(registration);
    expect(receipts.some((r) => !r.current())).toBe(true);
  } finally { actual.agentRegistry.untrack('helper-0'); get.mockRestore(); }
});
