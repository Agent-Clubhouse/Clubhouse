import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ICON_SOURCE_MAX_BYTES, ICON_STORED_MAX_BYTES } from '../../shared/icon-limits';
import type { DurableAgentConfig, Project } from '../../shared/types';

const decode = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false }, nativeImage: { createFromBuffer: decode } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

let projects: Project[] = [];
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projects),
  update: vi.fn(async (id: string, updates: Partial<Project>) => projects.map((p) => (p.id === id ? { ...p, ...updates } : p))),
  writeIconFile: vi.fn(async (id: string, _bytes: Uint8Array, extension: string) => `${id}.hash.${extension}`),
}));

let agents: Record<string, DurableAgentConfig[]> = {};
vi.mock('./agent-config', () => ({
  isSameProject: vi.fn(async (a: string, b: string) => a === b),
  getDurableConfig: vi.fn(async (projectPath: string, id: string) => agents[projectPath]?.find((a) => a.id === id) ?? null),
  listDurable: vi.fn(async (projectPath: string) => agents[projectPath] ?? []),
  updateDurable: vi.fn(async () => undefined),
  writeAgentIconFile: vi.fn(async (id: string, _bytes: Uint8Array, extension: string) => `${id}.hash.${extension}`),
  removeAgentIconFile: vi.fn(async () => undefined),
}));

let dispatcherState = { enabled: true, path: '/dispatcher' as string | null };
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  getDispatcherState: () => dispatcherState,
}));
vi.mock('./dispatcher/dispatcher-paths', () => ({ getDispatcherPath: () => '/dispatcher' }));

import * as agentConfig from './agent-config';
import { AppearanceError, listAgentAppearances, listProjectAppearances, updateAgentAppearance, updateProjectAppearance, type AppearanceActor } from './appearance-service';
import * as projectStore from './project-store';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SELF: AppearanceActor = { scope: 'own', agentId: 'a1', projectPath: '/one' };
const DISPATCHER: AppearanceActor = { scope: 'all', agentId: 'dispatcher' };
const CLI: AppearanceActor = { scope: 'all' };

let dir: string;

async function fileWith(name: string, bytes: Uint8Array | string): Promise<string> {
  const file = path.join(dir, name);
  await fsp.writeFile(file, bytes);
  return file;
}

function agent(id: string, overrides: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'indigo', createdAt: '2026-01-01', ...overrides } as DurableAgentConfig;
}

async function refusal(run: Promise<unknown>): Promise<string> {
  const err = await run.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppearanceError);
  return (err as AppearanceError).code;
}

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'appearance-'));
  projects = [
    { id: 'p1', name: 'one', path: '/one' },
    { id: 'p2', name: 'two', path: '/two', displayName: 'Second' },
  ];
  agents = { '/one': [agent('a1'), agent('a2')], '/two': [agent('b1')], '/dispatcher': [agent('dispatcher')] };
  dispatcherState = { enabled: true, path: '/dispatcher' };
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('updateProjectAppearance', () => {
  it('sets each field on the agent\'s own project by default', async () => {
    const result = await updateProjectAppearance(SELF, undefined, { displayName: '  Shiny  ', color: 'rose', emoji: '🚀' });
    expect(projectStore.update).toHaveBeenCalledWith('p1', { displayName: 'Shiny', color: 'rose', emoji: '🚀' });
    expect(result).toMatchObject({ id: 'p1', displayName: 'Shiny', color: 'rose', emoji: '🚀' });
  });

  it('clears fields with empty strings and never touches the project name', async () => {
    await updateProjectAppearance(SELF, undefined, { displayName: '', color: '', emoji: '', imagePath: '' });
    const write = vi.mocked(projectStore.update).mock.calls[0][1];
    expect(write).toEqual({ displayName: '', color: '', emoji: '', icon: '' });
    expect(write).not.toHaveProperty('name');
  });

  it('stores an image and clears the emoji', async () => {
    const result = await updateProjectAppearance(SELF, undefined, { imagePath: await fileWith('i.png', PNG) });
    expect(projectStore.writeIconFile).toHaveBeenCalledWith('p1', expect.anything(), 'png');
    expect(projectStore.update).toHaveBeenCalledWith('p1', { icon: 'p1.hash.png', emoji: '' });
    expect(result.hasImage).toBe(true);
  });

  it('lets an agent name its own project but refuses another', async () => {
    await updateProjectAppearance(SELF, 'one', { color: 'rose' });
    await updateProjectAppearance(SELF, '/one', { color: 'rose' });
    expect(await refusal(updateProjectAppearance(SELF, 'p2', { color: 'rose' }))).toBe('out_of_scope');
    expect(await refusal(updateProjectAppearance(SELF, 'Second', { color: 'rose' }))).toBe('out_of_scope');
    expect(projectStore.update).toHaveBeenCalledTimes(2);
  });

  it('lets the Dispatcher and the CLI change any project, by id, path or name', async () => {
    for (const actor of [DISPATCHER, CLI]) {
      for (const ref of ['p2', '/two', 'Second']) {
        expect((await updateProjectAppearance(actor, ref, { color: 'teal' })).id).toBe('p2');
      }
    }
  });

  it('makes the Dispatcher and the CLI say which project, and refuses an unknown or ambiguous one', async () => {
    expect(await refusal(updateProjectAppearance(DISPATCHER, undefined, { color: 'teal' }))).toBe('not_found');
    expect(await refusal(updateProjectAppearance(CLI, 'nope', { color: 'teal' }))).toBe('not_found');
    projects.push({ id: 'p3', name: 'one', path: '/three' });
    expect(await refusal(updateProjectAppearance(CLI, 'one', { color: 'teal' }))).toBe('ambiguous_project');
  });

  it('refuses an agent outside any registered project', async () => {
    const actor: AppearanceActor = { scope: 'own', agentId: 'x', projectPath: '/elsewhere' };
    expect(await refusal(updateProjectAppearance(actor, undefined, { color: 'rose' }))).toBe('not_found');
  });

  it('checks every field before writing anything', async () => {
    const image = await fileWith('i.png', PNG);
    expect(await refusal(updateProjectAppearance(SELF, undefined, { displayName: 'Fine', color: 'plaid' }))).toBe('invalid_color');
    expect(await refusal(updateProjectAppearance(SELF, undefined, { displayName: 'x'.repeat(257) }))).toBe('invalid_name');
    expect(await refusal(updateProjectAppearance(SELF, undefined, { emoji: 'x'.repeat(17) }))).toBe('invalid_emoji');
    expect(await refusal(updateProjectAppearance(SELF, undefined, { emoji: '🚀', imagePath: image }))).toBe('conflicting_icon');
    expect(await refusal(updateProjectAppearance(SELF, undefined, { color: 'rose', imagePath: path.join(dir, 'gone.png') }))).toBe('invalid_image');
    expect(await refusal(updateProjectAppearance(SELF, undefined, {}))).toBe('no_changes');
    expect(projectStore.update).not.toHaveBeenCalled();
    expect(projectStore.writeIconFile).not.toHaveBeenCalled();
  });
});

describe('updateAgentAppearance', () => {
  it('changes an agent\'s color and emoji, itself by default', async () => {
    const result = await updateAgentAppearance(SELF, undefined, { color: 'teal', emoji: '🦊' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/one', 'a1', { color: 'teal', emoji: '🦊' });
    // The emoji replaces any image, so its file goes.
    expect(agentConfig.removeAgentIconFile).toHaveBeenCalledWith('a1');
    expect(result.id).toBe('a1');
  });

  it('stores an image and clears the emoji, keeping the new file', async () => {
    await updateAgentAppearance(SELF, undefined, { imagePath: await fileWith('i.png', PNG) });
    expect(agentConfig.writeAgentIconFile).toHaveBeenCalledWith('a1', expect.anything(), 'png');
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/one', 'a1', { icon: 'a1.hash.png', emoji: null });
    expect(agentConfig.removeAgentIconFile).not.toHaveBeenCalled();
  });

  it('removes the image and the emoji with empty strings', async () => {
    await updateAgentAppearance(SELF, undefined, { emoji: '', imagePath: '' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/one', 'a1', { emoji: null, icon: null });
    expect(agentConfig.removeAgentIconFile).toHaveBeenCalledWith('a1');
  });

  it('never renames: a name in the updates isn\'t written', async () => {
    const updates = { name: 'new-name', color: 'teal' };
    await updateAgentAppearance(SELF, undefined, updates);
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/one', 'a1', { color: 'teal' });
  });

  it('refuses another agent for an ordinary agent, even in its own project', async () => {
    expect(await refusal(updateAgentAppearance(SELF, 'a2', { color: 'teal' }))).toBe('out_of_scope');
    expect(await refusal(updateAgentAppearance(SELF, 'b1', { color: 'teal' }))).toBe('out_of_scope');
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
  });

  it('lets the Dispatcher and the CLI change an agent in any project', async () => {
    await updateAgentAppearance(DISPATCHER, 'b1', { color: 'teal' });
    await updateAgentAppearance(CLI, 'a2', { color: 'rose' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/two', 'b1', { color: 'teal' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/one', 'a2', { color: 'rose' });
  });

  describe('the Dispatcher', () => {
    it('changes itself by default, in its own folder, without looking at projects', async () => {
      const result = await updateAgentAppearance(DISPATCHER, undefined, { color: 'teal', emoji: '🦊' });
      expect(agentConfig.updateDurable).toHaveBeenCalledWith('/dispatcher', 'dispatcher', { color: 'teal', emoji: '🦊' });
      expect(projectStore.list).not.toHaveBeenCalled();
      expect(result.id).toBe('dispatcher');
    });

    it('changes itself by id, image included', async () => {
      await updateAgentAppearance(DISPATCHER, 'dispatcher', { imagePath: await fileWith('i.png', PNG) });
      expect(agentConfig.writeAgentIconFile).toHaveBeenCalledWith('dispatcher', expect.anything(), 'png');
      expect(agentConfig.updateDurable).toHaveBeenCalledWith('/dispatcher', 'dispatcher', { icon: 'dispatcher.hash.png', emoji: null });
    });

    it('still changes itself turned off, when it asks as an ordinary agent in its own folder', async () => {
      const off: AppearanceActor = { scope: 'own', agentId: 'dispatcher', projectPath: '/dispatcher' };
      await updateAgentAppearance(off, undefined, { color: 'teal' });
      expect(agentConfig.updateDurable).toHaveBeenCalledWith('/dispatcher', 'dispatcher', { color: 'teal' });
    });

    it('can be changed by the CLI', async () => {
      await updateAgentAppearance(CLI, 'dispatcher', { emoji: '🦊' });
      expect(agentConfig.updateDurable).toHaveBeenCalledWith('/dispatcher', 'dispatcher', { emoji: '🦊' });
    });

    it('can\'t be changed by another agent', async () => {
      expect(await refusal(updateAgentAppearance(SELF, 'dispatcher', { color: 'teal' }))).toBe('out_of_scope');
      const inFolder: AppearanceActor = { scope: 'own', agentId: 'a1', projectPath: '/dispatcher' };
      expect(await refusal(updateAgentAppearance(inFolder, 'dispatcher', { color: 'teal' }))).toBe('out_of_scope');
      expect(agentConfig.updateDurable).not.toHaveBeenCalled();
      expect(agentConfig.writeAgentIconFile).not.toHaveBeenCalled();
    });

    it('keeps its name', async () => {
      await updateAgentAppearance(DISPATCHER, undefined, { name: 'Bob', color: 'teal' } as never);
      expect(agentConfig.updateDurable).toHaveBeenCalledWith('/dispatcher', 'dispatcher', { color: 'teal' });
    });

    it('takes the same checks as any agent', async () => {
      expect(await refusal(updateAgentAppearance(DISPATCHER, undefined, { color: 'plaid' }))).toBe('invalid_color');
      expect(await refusal(updateAgentAppearance(DISPATCHER, undefined, {}))).toBe('no_changes');
      expect(agentConfig.updateDurable).not.toHaveBeenCalled();
    });
  });

  it('refuses a bad color, an unknown, disposed or creating agent, and an empty change', async () => {
    agents['/one'].push(
      agent('gone', { disposedAt: '2026-01-02' } as Partial<DurableAgentConfig>),
      agent('new', { creation: { state: 'creating' } } as Partial<DurableAgentConfig>),
    );
    expect(await refusal(updateAgentAppearance(SELF, undefined, { color: 'plaid' }))).toBe('invalid_color');
    expect(await refusal(updateAgentAppearance(SELF, undefined, { color: '' }))).toBe('invalid_color');
    expect(await refusal(updateAgentAppearance(CLI, 'nope', { color: 'teal' }))).toBe('not_found');
    expect(await refusal(updateAgentAppearance(CLI, 'gone', { color: 'teal' }))).toBe('not_found');
    expect(await refusal(updateAgentAppearance(CLI, 'new', { color: 'teal' }))).toBe('agent_creating');
    expect(await refusal(updateAgentAppearance(SELF, undefined, {}))).toBe('no_changes');
    expect(await refusal(updateAgentAppearance(CLI, undefined, { color: 'teal' }))).toBe('not_found');
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
  });
});

describe('image files', () => {
  async function imageError(imagePath: string, cwd?: string): Promise<string> {
    const err = await updateAgentAppearance({ ...SELF, cwd }, undefined, { imagePath }).then(() => { throw new Error('expected a refusal'); }, (e: Error) => e);
    expect((err as AppearanceError).code).toBe('invalid_image');
    return err.message;
  }

  it('takes the type from the bytes, not the name', async () => {
    await updateAgentAppearance(SELF, undefined, { imagePath: await fileWith('photo.png', Buffer.from([0xff, 0xd8, 0xff, 0xe0])) });
    expect(agentConfig.writeAgentIconFile).toHaveBeenCalledWith('a1', expect.anything(), 'jpg');
    await updateAgentAppearance(SELF, undefined, { imagePath: await fileWith('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
    expect(agentConfig.writeAgentIconFile).toHaveBeenCalledWith('a1', expect.anything(), 'svg');
  });

  it('allows a file anywhere, and resolves a relative path from the working directory', async () => {
    await fileWith('rel.png', PNG);
    await updateAgentAppearance({ ...SELF, cwd: dir }, undefined, { imagePath: 'rel.png' });
    expect(agentConfig.writeAgentIconFile).toHaveBeenCalledTimes(1);
  });

  it('says why a file can\'t be used', async () => {
    expect(await imageError(path.join(dir, 'missing.png'))).toContain('doesn\'t exist');
    expect(await imageError('relative.png')).toContain('isn\'t absolute');
    expect(await imageError(dir)).toContain('isn\'t a file');
    expect(await imageError(await fileWith('notes.png', 'just some text'))).toContain('isn\'t a supported image');
    expect(await imageError(await fileWith('empty.png', ''))).toContain('isn\'t a supported image');
    expect(await imageError(await fileWith('big.png', Buffer.concat([PNG, Buffer.alloc(ICON_SOURCE_MAX_BYTES)])))).toContain('larger than');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says when a file can\'t be read', async () => {
    const file = await fileWith('locked.png', PNG);
    await fsp.chmod(file, 0o000);
    expect(await imageError(file)).toContain('can\'t be read');
  });

  it('stores a file at the stored limit as it is', async () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(ICON_STORED_MAX_BYTES - PNG.length)]);
    await updateAgentAppearance(SELF, undefined, { imagePath: await fileWith('max.png', bytes) });
    expect(decode).not.toHaveBeenCalled();
    expect(vi.mocked(agentConfig.writeAgentIconFile).mock.calls[0][1]).toEqual(bytes);
  });

  it('stores a larger image resized, as a PNG, for agents and projects', async () => {
    const small = Buffer.from('resized-png');
    const resize = vi.fn(() => ({ toPNG: () => small }));
    decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 4000, height: 2000 }), resize });
    const large = await fileWith('large.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(ICON_SOURCE_MAX_BYTES - 4)]));

    await updateAgentAppearance(SELF, undefined, { imagePath: large });
    await updateProjectAppearance(SELF, undefined, { imagePath: large });

    expect(resize).toHaveBeenCalledWith({ width: 256, height: 128, quality: 'good' });
    expect(agentConfig.writeAgentIconFile).toHaveBeenCalledWith('a1', small, 'png');
    expect(vi.mocked(projectStore.writeIconFile).mock.calls[0].slice(1)).toEqual([small, 'png']);
  });

  it('refuses a large image it can\'t resize, and says what would work', async () => {
    decode.mockReturnValue({ isEmpty: () => true });
    const corrupt = await fileWith('corrupt.png', Buffer.concat([PNG, Buffer.alloc(ICON_STORED_MAX_BYTES)]));
    const gif = await fileWith('large.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(ICON_STORED_MAX_BYTES)]));

    for (const file of [corrupt, gif]) {
      const message = await imageError(file);
      expect(message).toContain('can\'t be resized');
      expect(message).toContain('Use a PNG or JPEG, or a file of 256 KB or less');
    }
    expect(agentConfig.writeAgentIconFile).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('lists every project as it looks', async () => {
    expect((await listProjectAppearances()).map((p) => [p.id, p.displayName])).toEqual([['p1', null], ['p2', 'Second']]);
  });

  it('lists agents everywhere or in one project, skipping disposed helpers', async () => {
    agents['/two'].push(agent('gone', { disposedAt: '2026-01-02' } as Partial<DurableAgentConfig>));
    expect((await listAgentAppearances()).map((a) => [a.id, a.projectId])).toEqual([['a1', 'p1'], ['a2', 'p1'], ['b1', 'p2'], ['dispatcher', '__dispatcher__']]);
    expect((await listAgentAppearances('Second')).map((a) => a.id)).toEqual(['b1']);
    expect(await refusal(listAgentAppearances('nope'))).toBe('not_found');
  });

  it('still lists the other projects when one can\'t be read', async () => {
    vi.mocked(agentConfig.listDurable).mockRejectedValueOnce(new Error('EIO'));
    expect((await listAgentAppearances()).map((a) => a.id)).toEqual(['b1', 'dispatcher']);
  });

  it('leaves the Dispatcher out while it is off', async () => {
    dispatcherState = { enabled: false, path: '/dispatcher' };
    expect((await listAgentAppearances()).map((a) => a.id)).toEqual(['a1', 'a2', 'b1']);
  });
});
