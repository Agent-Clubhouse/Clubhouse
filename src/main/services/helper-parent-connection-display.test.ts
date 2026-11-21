import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ home: '', allowed: true }));
vi.mock('electron', () => ({ app: { getPath: () => m.home } }));
vi.mock('./project-store', () => { throw new Error('Ordinary project owner must not load'); });
vi.mock('./agent-config', () => { throw new Error('Ordinary agent owner must not load'); });
vi.mock('./helper-wire-source', () => { throw new Error('Operational helper collection must not load'); });
import { getBaseDirPath } from './base-dir';
import { readHelperParentConnectionForDisplay as read } from './helper-parent-connection-display';
import { projectConnectionEndpointFieldsForDisplay } from './connection-endpoint-fields-display';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
let root: string, a: string, b: string;
const agent = (extra = {}) => ({ id: 'helper', name: 'Selected helper', parentAgentId: 'parent', parentProjectPath: b, ...extra });
const put = (p: string, rows: unknown[]) => fs.writeFile(path.join(p, '.clubhouse', 'agents.json'), JSON.stringify(rows));
async function selected(extra = {}) {
  const raw = agent(extra); await put(a, [raw, { id: 'parent', name: 'PRIVATE_WRONG_PROJECT_PARENT' }]);
  const fields = projectConnectionEndpointFieldsForDisplay(raw.id, raw); if (fields.state !== 'ok') throw new Error('fixture');
  const target = { agent: raw, project: { id: 'a', name: 'Selected project', path: a } } as unknown as import('./agent-config-reader').AgentConfigTarget;
  const receipt = captureReadOnlyAgentTargetWitness(target); expect(receipt.current()).toBe(true);
  return { agentId: raw.id, projectId: 'a', projectPath: a, receipt, fields: fields.value, parentAgentId: raw.parentAgentId, parentProjectPath: raw.parentProjectPath };
}
const disk = async (folder = root): Promise<unknown> => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const p = path.join(folder, name), s = await fs.lstat(p); return [name, s.isDirectory() ? { ino: s.ino, contents: await disk(p) } : { ino: s.ino, mtimeMs: s.mtimeMs, bytes: (await fs.readFile(p)).toString('base64') }]; })));
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-helper-parent-'))); m.home = root; m.allowed = true; a = path.join(root, 'a'); b = path.join(root, 'b');
  for (const p of [a, b]) await fs.mkdir(path.join(p, '.clubhouse'), { recursive: true }); await fs.mkdir(getBaseDirPath(), { recursive: true });
  await fs.writeFile(path.join(getBaseDirPath(), 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'Selected project', path: a }, { id: 'b', name: 'Parent custom project', path: b }] })); await put(b, [{ id: 'parent', name: 'Qualified parent', instructions: 'PRIVATE_INSTRUCTIONS' }]);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('shows the exact-project parent and two configured defaults without global-ID adoption, owner loads or writes', async () => {
  const s = await selected(), before = await disk(), receipts: Array<{ current(): boolean }> = [], result = read(s, { authorized: () => true, receipts });
  expect(result).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 1, parentReference: { agentId: 'parent', projectName: { value: 'Parent custom project' } }, entries: [{ source: 'helper-parent', endpoint: { projectId: 'b', fields: { name: { value: 'Qualified parent' } } }, applicability: 'configured', directions: [{ from: 'selected' }, { from: 'endpoint' }] }] } }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|projectPath|ProjectPath|instructions/); expect(receipts.every((r) => r.current())).toBe(true); expect(await disk()).toEqual(before);
});
it.each(['absent', 'unregistered', 'corrupt', 'disposed'] as const)('preserves the known saved parent ID while unavailable/removed metadata does not become configured: %s', async (mode) => {
  const s = await selected(mode === 'unregistered' ? { parentProjectPath: path.join(root, 'not-registered') } : {});
  if (mode === 'absent') await put(b, []); if (mode === 'corrupt') await fs.writeFile(path.join(b, '.clubhouse', 'agents.json'), '{broken'); if (mode === 'disposed') await put(b, [{ id: 'parent', name: 'Historical parent', disposedAt: '2026-11-20' }]);
  const before = await disk(), result = read(s, { authorized: () => true, receipts: [] }); expect(result).toMatchObject({ state: 'ok', value: { knownMatches: 1, parentReference: { agentId: 'parent' }, complete: mode === 'disposed' } });
  if (result.state !== 'ok') throw new Error('fixture'); expect(result.value.entries.every((e) => !e.directions.length)).toBe(true); expect(await disk()).toEqual(before);
});
it('retains actual parent and selected-reference receipts through caller assembly and rejects revoked reads', async () => {
  const s = await selected(), receipts: Array<{ current(): boolean }> = []; expect(read(s, { authorized: () => m.allowed, receipts }).state).toBe('ok'); expect(receipts.every((r) => r.current())).toBe(true); await put(b, []); expect(receipts.some((r) => !r.current())).toBe(true);
  const again: Array<{ current(): boolean }> = []; expect(read(s, { authorized: () => true, receipts: again }).state).toBe('ok'); await put(a, [agent({ parentAgentId: 'new-parent' })]); expect(again.some((r) => !r.current())).toBe(true); m.allowed = false; expect(read(s, { authorized: () => m.allowed, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
it('keeps a verified nonhelper empty and malformed/self/extra-page parent references unavailable', async () => {
  expect(read(await selected({ parentAgentId: undefined }), { authorized: () => true, receipts: [] })).toMatchObject({ state: 'ok', value: { complete: true, knownMatches: 0, entries: [] } });
  for (const parentAgentId of ['helper', 'bad||remote', {}]) expect(read(await selected({ parentAgentId }), { authorized: () => true, receipts: [] })).toMatchObject({ state: 'unavailable', reason: 'invalid' });
  expect(read(await selected(), { authorized: () => true, receipts: [], offset: 8 })).toMatchObject({ state: 'unavailable', reason: 'invalid' });
});
