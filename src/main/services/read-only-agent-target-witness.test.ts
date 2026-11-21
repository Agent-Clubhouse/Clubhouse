import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { captureReadOnlyAgentInventoryWitness, captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import type { AgentConfigTarget } from './agent-config-reader';
const m = vi.hoisted(() => ({ base: '' }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
let root: string, project: string, agents: string, projects: string, target: AgentConfigTarget;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-target-witness-'));
  m.base = path.join(root, 'profile'); project = path.join(root, 'project');
  await fs.mkdir(m.base); await fs.mkdir(path.join(project, '.clubhouse'), { recursive: true });
  agents = path.join(project, '.clubhouse', 'agents.json'); projects = path.join(m.base, 'projects.json');
  target = { agent: { id: 'a1', name: 'Selected', worktreePath: project } as AgentConfigTarget['agent'], project: { id: 'p1', path: project, name: 'Project' } };
  await fs.writeFile(agents, JSON.stringify([target.agent]));
  await fs.writeFile(projects, JSON.stringify({ version: 1, projects: [target.project] }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe('synchronous admitted target inventory witness', () => {
  it('refuses to mint a fresh list receipt for stale or incomplete rows', async () => {
    expect(() => captureReadOnlyAgentInventoryWitness(project, [])).toThrow();
    expect(() => captureReadOnlyAgentInventoryWitness(project, [{ ...target.agent, name: 'Stale name' }])).toThrow();
  });
  it('binds a complete list including disposed membership and verified primary/backup absence', async () => {
    await fs.writeFile(agents, JSON.stringify([{ ...target.agent, disposedAt: '2026-11-19' }]));
    const rows = JSON.parse(await fs.readFile(agents, 'utf8'));
    const full = captureReadOnlyAgentInventoryWitness(project, rows);
    expect(full.current()).toBe(true);
    await fs.writeFile(agents, JSON.stringify([{ ...rows[0], parentAgentId: 'different' }]));
    expect(full.current()).toBe(false);
    await fs.rm(agents);
    const empty = captureReadOnlyAgentInventoryWitness(project, []);
    expect(empty.current()).toBe(true);
    await fs.writeFile(agents + '.bak', '[]');
    expect(empty.current()).toBe(false);
    await fs.rm(agents + '.bak');
    const absent = captureReadOnlyAgentInventoryWitness(project, []);
    await fs.writeFile(agents, '[]');
    expect(absent.current()).toBe(false);
  });
  it('attests the exact real primary inventories without writing or recovering them', async () => {
    const before = await Promise.all([fs.readFile(agents), fs.readFile(projects), fs.readdir(path.dirname(agents)), fs.readdir(m.base)]);
    const witness = captureReadOnlyAgentTargetWitness(target);
    expect(witness.current()).toBe(true);
    expect(witness.current()).toBe(true);
    expect(await Promise.all([fs.readFile(agents), fs.readFile(projects), fs.readdir(path.dirname(agents)), fs.readdir(m.base)])).toEqual(before);
  });
  it.each(['removed', 'disposed', 'name-collision', 'project-removed', 'same-bytes-replaced', 'backup-only'] as const)('refuses a real %s inventory change after an awaited boundary without a watcher/cache update', async (condition) => {
    const witness = captureReadOnlyAgentTargetWitness(target);
    const original = await fs.readFile(agents);
    await Promise.resolve();
    if (condition === 'removed') await fs.writeFile(agents, '[]');
    if (condition === 'disposed') await fs.writeFile(agents, JSON.stringify([{ ...target.agent, disposedAt: '2026-11-19T00:00:00Z' }]));
    if (condition === 'name-collision') await fs.writeFile(agents, JSON.stringify([{ ...target.agent, id: 'b1', name: 'a1' }]));
    if (condition === 'project-removed') await fs.writeFile(projects, JSON.stringify({ version: 1, projects: [] }));
    if (condition === 'same-bytes-replaced') { await fs.rename(agents, agents + '.original'); await fs.writeFile(agents, original); }
    if (condition === 'backup-only') { await fs.writeFile(agents + '.bak', original); await fs.rm(agents); }
    expect(witness.current()).toBe(false);
    if (condition === 'backup-only') { await expect(fs.access(agents)).rejects.toThrow(); expect(await fs.readFile(agents + '.bak')).toEqual(original); }
  });
  it('refuses an admitted clone that no longer matches the exact stored ID or fields', async () => {
    await fs.writeFile(agents, JSON.stringify([{ ...target.agent, id: 'b1', name: 'a1' }]));
    expect(() => captureReadOnlyAgentTargetWitness(target)).toThrow();
  });
  it('refuses linked/oversized/damaged inventories rather than reading backup data or returning empty', async () => {
    const witness = captureReadOnlyAgentTargetWitness(target);
    await fs.rename(agents, agents + '.original');
    await fs.symlink(agents + '.original', agents);
    expect(witness.current()).toBe(false);
    await fs.rm(agents); await fs.writeFile(agents, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(() => captureReadOnlyAgentTargetWitness(target)).toThrow();
    await fs.writeFile(agents, '{}');
    expect(() => captureReadOnlyAgentTargetWitness(target)).toThrow();
  });
});
