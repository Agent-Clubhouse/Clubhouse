import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readRemoteAgentChanges } from './remote-agent-changes';
import { ReadOnlyGitError } from './read-only-repository-changes';
const m = vi.hoisted(() => ({ base: '', project: '', phase: '', roots: 0, heads: 0, mutate: async () => {}, target: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => undefined }));
vi.mock('./agent-system', () => ({ isAgentRunning: () => false }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));
vi.mock('./read-only-repository-changes', () => ({
  ReadOnlyGitError: class extends Error { constructor(readonly code: number, readonly stderr: string) { super('git unavailable'); } },
  readOnlyRepositoryRoot: async () => { if (++m.roots === 2 && m.phase === 'root') await m.mutate(); return m.project; },
  readOnlyGit: async (_cwd: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) { if (++m.heads === 2 && m.phase === 'HEAD') await m.mutate(); return Buffer.from('a'.repeat(40)); }
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main^{commit}')) return Buffer.from('b'.repeat(40));
    if (args[0] === 'symbolic-ref' && args.includes('HEAD')) return Buffer.from('feature');
    if (args[0] === 'merge-base') return Buffer.from('b'.repeat(40));
    throw new ReadOnlyGitError(1, 'missing ref');
  },
  readOnlyRepositoryChanges: async () => { if (m.phase === 'comparison') await m.mutate(); return { files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 }; },
}));
let root: string, agents: string;
const config = () => ({ id: 'a1', name: 'Selected', worktreePath: m.project });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-real-target-fence-'));
  m.base = path.join(root, 'profile'); m.project = path.join(root, 'project'); m.roots = 0; m.heads = 0; m.phase = '';
  await fs.mkdir(m.base); await fs.mkdir(path.join(m.project, '.clubhouse'), { recursive: true });
  agents = path.join(m.project, '.clubhouse', 'agents.json');
  await fs.writeFile(agents, JSON.stringify([config()]));
  await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Project', path: m.project }] }));
  // Modeled strict resolver reads the real primary inventory; the final witness itself is REAL, not mocked.
  m.target.mockImplementation(async (reference: string) => {
    const rows = JSON.parse(await fs.readFile(agents, 'utf8'));
    const selected = rows.find((a: { id: string }) => a.id === reference) ?? rows.find((a: { name: string }) => a.name === reference);
    if (!selected) throw new Error('No registered agent matches that reference.');
    return { agent: selected, project: { id: 'p1', name: 'Project', path: m.project } };
  });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe('Changes final-await target fence with real inventory files', () => {
  it('accepts unchanged sleeping target evidence with a real no-recovery witness', async () => {
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).status).toBe(200);
  });
  it.each(['root', 'HEAD'] as const)('withholds a sleeping target disposed by a real file write during the final %s await', async (phase) => {
    m.phase = phase;
    m.mutate = async () => { await fs.writeFile(agents, JSON.stringify([{ ...config(), disposedAt: '2026-11-19T00:00:00Z' }])); };
    const response = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('files');
  });
  it('withholds an exact ID removed and replaced by a same-folder name collision in the real inventory', async () => {
    m.phase = 'comparison';
    m.mutate = async () => { await fs.writeFile(agents, JSON.stringify([{ ...config(), id: 'b1', name: 'a1' }])); };
    const response = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('files');
  });
  it('withholds a project removed from the real registry during the final HEAD await', async () => {
    m.phase = 'HEAD';
    m.mutate = async () => { await fs.writeFile(path.join(m.base, 'projects.json'), JSON.stringify({ version: 1, projects: [] })); };
    const response = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('files');
  });
});
