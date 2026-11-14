import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

const projects = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; path: string }> }));
vi.mock('../project-store', () => ({ list: async () => projects.list }));
vi.mock('../agent-config', async (original) => ({
  ...await original<typeof import('../agent-config')>(),
  isSameProject: async (a: string, b: string) => path.resolve(a) === path.resolve(b),
}));
const grants = vi.hoisted(() => ({
  setAgentGrant: vi.fn(() => { throw new Error('Project parts must not change grants.'); }),
  resetAgentGrants: vi.fn(() => { throw new Error('Project parts must not change grants.'); }),
  applyTemplateGrants: vi.fn(() => { throw new Error('Project parts must not change grants.'); }),
}));
vi.mock('../agent-grants-service', async (original) => ({ ...await original<typeof import('../agent-grants-service')>(), ...grants }));

import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, type ManagedAgentsService } from './service';
import { addProjectPart, keepProjectPart, projectPartKey, projectPartsInventory, reviewProjectPart, updateProjectPart } from './project-parts';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';

let root: string, repo: string, data: string, service: ManagedAgentsService;
let agents: DurableAgentConfig[];
const setManagedSetup = vi.fn(async (_p: string, _a: string, _s: ManagedAgentSetup | null): Promise<void> => { throw new Error('Project parts must not assign anything.'); });
const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
const parts = (...rel: string[]) => path.join(repo, '.clubhouse', 'parts', ...rel);
const write = (rel: string, content: string, mode?: number) => {
  const file = parts(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
};
const marker = () => path.join(root, 'ran');
const inventory = () => projectPartsInventory(service, repo);
const item = async (key: string) => (await inventory()).items.find((i) => i.key === key)!;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-parts-')));
  repo = path.join(root, 'repo');
  data = path.join(root, 'data');
  fs.mkdirSync(repo);
  projects.list = [{ id: 'proj-1', name: 'Demo', path: repo }];
  agents = [];
  setManagedSetup.mockClear();
  _resetSettingsAuditForTesting(false);
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(data, 'catalog') }),
    state: createManagedStateStore(path.join(data, 'managed')),
    listProjects: async () => projects.list,
    listAgents: async () => agents,
    getAgent: async (_p, id) => agents.find((a) => a.id === id) ?? null,
    setManagedSetup,
    isRunning: () => false,
  });
  // Something that would leave a mark if anything ran it.
  write('skills/review/SKILL.md', '---\nname: review\n---\nReview the change.\n');
  write('skills/review/run.sh', `#!/bin/sh\ntouch ${marker()}\n`, 0o755);
  write('instructions/house-style.md', 'Write short sentences.\n');
  write('mcp.json', JSON.stringify({ mcpServers: {
    tickets: { command: '/bin/sh', args: ['-c', `touch ${marker()}`], env: { TICKETS_URL: 'https://example.test' } },
    clubhouse: { command: 'clubhouse-mcp' },
  } }));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('parts checked into a project repository', () => {
  it('lists what the repository offers without writing to the library, running anything or selecting it', async () => {
    const inv = await inventory();
    expect(inv).toMatchObject({ projectId: 'proj-1', projectName: 'Demo', gone: [] });
    expect(inv.items.map((i) => [i.key, i.state])).toEqual([
      ['skill:review', 'available'], ['block:house-style', 'available'], ['mcp:tickets', 'available'],
    ]);
    expect(inv.notes).toContain('The clubhouse server is Clubhouse\'s own, so it isn\'t offered.');
    expect(JSON.stringify(inv)).not.toContain(repo);
    await reviewProjectPart(service, repo, 'skill:review');
    await reviewProjectPart(service, repo, 'mcp:tickets');
    expect(await service.liveEntries()).toEqual({});
    expect(await service.projectPartMeta()).toEqual({});
    expect(fs.existsSync(path.join(data, 'catalog'))).toBe(false);
    expect(fs.existsSync(marker())).toBe(false);
    expect(setManagedSetup).not.toHaveBeenCalled();
  });

  it('keeps env values out and shows supporting files and executable flags for review', async () => {
    const mcp = await reviewProjectPart(service, repo, 'mcp:tickets');
    expect(mcp.content).toMatchObject({ kind: 'mcp', serverKey: 'tickets', command: '/bin/sh', envVars: ['TICKETS_URL'] });
    expect(JSON.stringify(mcp)).not.toContain('example.test');
    expect(mcp.droppedEnvValues).toEqual(['TICKETS_URL']);
    const skill = await reviewProjectPart(service, repo, 'skill:review');
    expect(skill.content).toMatchObject({ kind: 'skill', files: expect.arrayContaining([expect.objectContaining({ path: 'run.sh', ...(process.platform !== 'win32' && { executable: true }) })]) });
  });

  it('refuses untrusted content whole: links, credentials and duplicate fields', async () => {
    write('skills/leaky/SKILL.md', '---\nname: leaky\n---\nUse ghp_0123456789abcdefghijklmnopqrstuvwxyzAB to sign in.\n');
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'SKILL.md'), '---\nname: linked\n---\nOutside.\n');
    try { fs.symlinkSync(path.join(root, 'outside'), parts('skills', 'linked'), 'dir'); } catch { /* telemetry-exempt: no symlink permission on this machine */ }
    write('mcp.json', '{"mcpServers":{"a":{"command":"x"},"a":{"command":"y"}}}');
    const inv = await inventory();
    expect(inv.items.find((i) => i.key === 'skill:leaky')).toMatchObject({ state: 'refused', problem: expect.stringContaining('credentials') });
    const linked = inv.items.find((i) => i.key === 'skill:linked');
    if (process.platform !== 'win32') expect(linked).toMatchObject({ state: 'refused', problem: expect.stringContaining('link') });
    expect(inv.items.some((i) => i.kind === 'mcp')).toBe(false);
    expect(inv.notes.some((n) => n.includes('duplicate fields'))).toBe(true);
    await expect(reviewProjectPart(service, repo, 'skill:leaky')).rejects.toThrow('credentials');
    await expect(addProjectPart(service, repo, 'skill:leaky', 'any', { mode: 'copy', name: 'Leaky' })).rejects.toThrow();
    expect(await service.liveEntries()).toEqual({});
  });

  it('refuses a parts folder reached through a link', async () => {
    fs.rmSync(path.join(repo, '.clubhouse'), { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere', 'parts', 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'elsewhere', 'parts', 'instructions', 'x.md'), 'Outside the repo.\n');
    try { fs.symlinkSync(path.join(root, 'elsewhere'), path.join(repo, '.clubhouse'), 'dir'); } catch { return; /* telemetry-exempt: no symlink permission */ }
    const inv = await inventory();
    expect(inv.items).toEqual([]);
    expect(inv.notes.join(' ')).toContain('link');
  });

  it('adds a reviewed part with project provenance and selects it for no one', async () => {
    const review = await reviewProjectPart(service, repo, 'block:house-style');
    const added = await user(() => addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: review.suggestedName }));
    expect(added).toMatchObject({ name: 'house-style', project: { projectId: 'proj-1', projectName: 'Demo' }, usedBy: [] });
    expect((await service.liveEntries())[added.id]).toMatchObject({ owner: { kind: 'library' }, source: { kind: 'project', projectId: 'proj-1', key: 'block:house-style' } });
    expect(await item('block:house-style')).toMatchObject({ state: 'added', partId: added.id });
    expect(setManagedSetup).not.toHaveBeenCalled();
    expect(Object.values(grants).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    await expect(addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: 'Again' })).rejects.toThrow('already in the library');
  });

  it('never shadows a library part: same content is reused only when chosen, a different one is added beside it', async () => {
    const same = await user(() => service.createPart({ name: 'Style', content: { kind: 'block', content: 'Write short sentences.\n' } }));
    const other = await user(() => service.createPart({ name: 'house-style', content: { kind: 'block', content: 'Something else.' } }));
    const review = await reviewProjectPart(service, repo, 'block:house-style');
    expect(review.matches).toEqual([
      { id: same.id, name: 'Style', sameContent: true, builtin: false, reusable: true },
      { id: other.id, name: 'house-style', sameContent: false, builtin: false, reusable: false },
    ]);
    expect(review.suggestedName).toBe('house-style 2');
    await expect(user(() => addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: 'house-style' }))).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'reuse', partId: other.id })).rejects.toMatchObject({ code: 'stale' });
    expect((await user(() => addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'reuse', partId: same.id }))).id).toBe(same.id);
    expect((await service.getPart(other.id)).content).toEqual({ kind: 'block', content: 'Something else.' });
    expect(Object.keys(await service.liveEntries())).toHaveLength(2);
    // The chosen part now follows the repository's copy, so the row says so and a later change shows on it.
    expect(await item('block:house-style')).toMatchObject({ state: 'added', partId: same.id, partName: 'Style' });
    write('instructions/house-style.md', 'Write shorter sentences.\n');
    const changed = await item('block:house-style');
    expect(changed).toMatchObject({ state: 'changed', partId: same.id });
    expect((await service.getPart(same.id)).content).toEqual({ kind: 'block', content: 'Write short sentences.\n' });
    await user(() => updateProjectPart(service, repo, same.id, same.revision, changed.hash!));
    expect((await service.getPart(same.id)).content).toEqual({ kind: 'block', content: 'Write shorter sentences.\n' });
    expect((await item('block:house-style')).state).toBe('added');
  });

  it('names with spaces or other scripts get a stable catalog-safe key and can be added', async () => {
    write('instructions/Code style.md', 'Two spaces.\n');
    write('instructions/café.md', 'Coffee rules.\n');
    write('skills/my skill/SKILL.md', '---\nname: my skill\n---\nDo it.\n');
    const inv = await inventory();
    const named = (name: string) => inv.items.find((i) => i.name === name)!;
    for (const name of ['Code style', 'café', 'my skill']) {
      const it = named(name);
      expect(it.state).toBe('available');
      expect(it.key).toMatch(/^(block|skill):[A-Za-z0-9][\w.:-]*$/);
    }
    expect(named('Code style').key).toMatch(/^block:Code-style:[0-9a-f]{10}$/);
    expect(named('café').key).toMatch(/^block:cafe:[0-9a-f]{10}$/);
    expect(projectPartKey('block', 'café')).toBe(named('café').key);
    expect(projectPartKey('block', 'cafe')).toBe('block:cafe');
    expect(projectPartKey('block', 'Code style')).not.toBe(projectPartKey('block', 'Code-style'));
    expect((await inventory()).items.map((i) => i.key)).toEqual(inv.items.map((i) => i.key));
    for (const name of ['Code style', 'café']) {
      const it = named(name);
      const added = await user(() => addProjectPart(service, repo, it.key, it.hash!, { mode: 'copy', name }));
      expect((await service.liveEntries())[added.id].source).toEqual({ kind: 'project', projectId: 'proj-1', key: it.key });
      expect(await item(it.key)).toMatchObject({ state: 'added', name });
    }
  });

  it('a hashed key never equals a plain file name', async () => {
    write('instructions/Code style.md', 'Spaces.\n');
    const hashed = projectPartKey('block', 'Code style');
    // The old form of the key, as a real file name, stays its own part.
    write(`instructions/${hashed.slice('block:'.length).replace(':', '-')}.md`, 'A plain name.\n');
    const inv = await inventory();
    const keys = inv.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(inv.items.find((i) => i.name === 'Code style')).toMatchObject({ key: hashed, state: 'available' });
    const review = await reviewProjectPart(service, repo, hashed);
    expect(review.content).toEqual({ kind: 'block', content: 'Spaces.\n' });
    expect(hashed.split(':')).toHaveLength(3);
  });

  it('a part that follows another repository part is never reused for this one', async () => {
    const first = await reviewProjectPart(service, repo, 'block:house-style');
    const fromA = await user(() => addProjectPart(service, repo, 'block:house-style', first.item.hash!, { mode: 'copy', name: 'House style' }));
    write('instructions/house-style.md', 'Changed.\n');
    const changed = await item('block:house-style');
    await user(() => keepProjectPart(service, repo, fromA.id, changed.hash!));
    // A second project offers the original content under another name.
    const repoB = path.join(root, 'repo-b');
    fs.mkdirSync(path.join(repoB, '.clubhouse', 'parts', 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(repoB, '.clubhouse', 'parts', 'instructions', 'style.md'), 'Write short sentences.\n');
    projects.list = [...projects.list, { id: 'proj-2', name: 'Other', path: repoB }];
    const reviewB = await reviewProjectPart(service, repoB, 'block:style');
    expect(reviewB.matches).toEqual([{ id: fromA.id, name: 'House style', sameContent: true, builtin: false, reusable: false }]);
    await expect(addProjectPart(service, repoB, 'block:style', reviewB.item.hash!, { mode: 'reuse', partId: fromA.id })).rejects.toThrow('already follows');
    // A's row and Keep mine are untouched.
    expect((await item('block:house-style')).state).toBe('kept');
    // A custom part linked to B can't then be taken by another key either.
    const mine = await user(() => service.createPart({ name: 'Mine', content: { kind: 'block', content: 'Write short sentences.\n' } }));
    await user(() => addProjectPart(service, repoB, 'block:style', reviewB.item.hash!, { mode: 'reuse', partId: mine.id }));
    write('instructions/again.md', 'Write short sentences.\n');
    const reviewA = await reviewProjectPart(service, repo, 'block:again');
    expect(reviewA.matches.find((m) => m.id === mine.id)).toMatchObject({ sameContent: true, reusable: false });
    await expect(addProjectPart(service, repo, 'block:again', reviewA.item.hash!, { mode: 'reuse', partId: mine.id })).rejects.toThrow('already follows');
    await expect(service.linkProjectPart(mine.id, { projectId: 'proj-1', key: 'block:again' }, 'h')).rejects.toThrow('already follows');
  });

  it('a change in the repository waits for the person: the difference, then Update or Keep mine', async () => {
    const first = await reviewProjectPart(service, repo, 'skill:review');
    const added = await user(() => addProjectPart(service, repo, 'skill:review', first.item.hash!, { mode: 'copy', name: 'Review' }));
    write('skills/review/SKILL.md', '---\nname: review\n---\nReview the change carefully.\n');
    const changed = await item('skill:review');
    expect(changed.state).toBe('changed');
    // No silent overwrite: the library part is as it was.
    expect((await service.getPart(added.id)).revision).toBe(added.revision);
    const review = await reviewProjectPart(service, repo, 'skill:review');
    expect(review.current).toMatchObject({ id: added.id, revision: added.revision });
    expect(JSON.stringify(review.current!.content)).toContain('Review the change.');
    expect(JSON.stringify(review.content)).toContain('carefully');

    await expect(keepProjectPart(service, repo, added.id, 'not-the-current-copy')).rejects.toMatchObject({ code: 'stale' });
    await user(() => keepProjectPart(service, repo, added.id, changed.hash!));
    expect((await item('skill:review')).state).toBe('kept');
    expect((await service.getPart(added.id)).revision).toBe(added.revision);

    write('skills/review/SKILL.md', '---\nname: review\n---\nReview it twice.\n');
    const again = await item('skill:review');
    expect(again.state).toBe('changed');
    await expect(updateProjectPart(service, repo, added.id, added.revision, changed.hash!)).rejects.toMatchObject({ code: 'stale' });
    const updated = await user(() => updateProjectPart(service, repo, added.id, added.revision, again.hash!));
    expect(updated.revision).toBe(added.revision + 1);
    expect(JSON.stringify((await service.getPart(added.id)).content)).toContain('twice');
    expect((await item('skill:review')).state).toBe('added');
  });

  it('an edit in the library alone is not a repository change', async () => {
    const review = await reviewProjectPart(service, repo, 'block:house-style');
    const added = await user(() => addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: 'Style' }));
    await user(() => service.updatePart({ id: added.id, expectedRevision: added.revision, content: { kind: 'block', content: 'My own wording.' } }));
    expect((await item('block:house-style')).state).toBe('added');
  });

  it('a part the repository drops, or a removed project, leaves the part and its agents as they are', async () => {
    const review = await reviewProjectPart(service, repo, 'block:house-style');
    const added = await user(() => addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: 'Style' }));
    const setup: ManagedAgentSetup = { version: 1, blocks: [added.id], skills: [], mcps: [] };
    agents = [{ id: 'agent-1', name: 'lead', color: 'blue', managed: setup } as DurableAgentConfig];
    fs.rmSync(parts('instructions', 'house-style.md'));
    const inv = await inventory();
    expect(inv.items.find((i) => i.key === 'block:house-style')).toBeUndefined();
    expect(inv.gone).toEqual([{ key: 'block:house-style', partId: added.id, partName: 'Style' }]);
    expect((await service.getPart(added.id)).usedBy).toMatchObject([{ agentId: 'agent-1' }]);

    projects.list = [];
    await expect(inventory()).rejects.toMatchObject({ code: 'not_found' });
    const kept = await service.getPart(added.id);
    expect(kept.project).toEqual({ projectId: 'proj-1' });
    expect(kept.content).toEqual({ kind: 'block', content: 'Write short sentences.\n' });
    expect((await service.getSetup('/any', 'agent-1'))?.blocks).toContain(added.id);
    expect(setManagedSetup).not.toHaveBeenCalled();
  });

  it('refuses a stale review and an unregistered project', async () => {
    const review = await reviewProjectPart(service, repo, 'block:house-style');
    write('instructions/house-style.md', 'Changed after the review.\n');
    await expect(addProjectPart(service, repo, 'block:house-style', review.item.hash!, { mode: 'copy', name: 'Style' })).rejects.toMatchObject({ code: 'stale' });
    await expect(projectPartsInventory(service, path.join(root, 'not-registered'))).rejects.toMatchObject({ code: 'not_found' });
    expect(await service.liveEntries()).toEqual({});
  });
});
