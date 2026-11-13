import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '', inventory: vi.fn(), canvas: vi.fn(), remove: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fixture.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => null }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => []) }));
vi.mock('./group-project-delete-inventory', () => ({ readGroupProjectDeletionInventory: fixture.inventory }));
vi.mock('./group-project-canvas-inventory', () => ({ readGroupProjectCanvasInventory: fixture.canvas, removeGroupProjectFromCanvasInventory: fixture.remove }));
vi.mock('./plugin-storage', () => ({ writeKeyWithinCanvasBarrier: vi.fn() }));

import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectHost } from './group-project-host';
import { createLocalGroupProjectDeleteService } from './group-project-delete-service';

async function restart() {
  await groupProjectRegistry.flush();
  await groupProjectHost.flushBoards();
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'group-project-delete-'));
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
  fixture.canvas.mockResolvedValue({ revision: 'canvas', entries: [] });
  fixture.remove.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  fixture.inventory.mockReset(); fixture.canvas.mockReset(); fixture.remove.mockReset();
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
  await fs.rm(fixture.home, { recursive: true, force: true });
});

describe('group project deletion recovery with the host journal', () => {
  it.each(['canvas', 'bindings', 'finish'] as const)('resumes after restart when %s fails', async (step) => {
    const project = await groupProjectHost.create('Release');
    fixture.inventory.mockResolvedValue({ groupProjectId: project.id, members: [], exclusions: [], canvases: [], actions: [], grants: [], messages: 0, topics: 0, machines: [], revisions: [String(project.seq), 'canvas'] });
    let fail = true;
    fixture.remove.mockImplementation(async () => { if (step === 'canvas' && fail) { fail = false; throw new Error(step); } });
    const release = vi.fn(() => { if (step === 'bindings' && fail) { fail = false; throw new Error(step); } });
    const finish = groupProjectHost.finishDelete.bind(groupProjectHost);
    vi.spyOn(groupProjectHost, 'finishDelete').mockImplementation(async (...args) => {
      if (step === 'finish' && fail) { fail = false; throw new Error(step); }
      return finish(...args);
    });
    const service = createLocalGroupProjectDeleteService(release);
    const preview = await service.preview(project.id, 1);
    await expect(service.confirm(project.id, 1, preview.token)).rejects.toThrow(step);
    expect(await groupProjectHost.get(project.id)).toBeNull();
    expect((await groupProjectHost.listPendingDeletes()).map((t) => t.groupProjectId)).toContain(project.id);
    await restart();
    expect(await groupProjectRegistry.get(project.id)).toBeNull();
    await createLocalGroupProjectDeleteService(release).recoverPending();
    expect(await groupProjectHost.listPendingDeletes()).toEqual([]);
    expect((await groupProjectHost.listTombstones()).find((t) => t.groupProjectId === project.id)?.state).toBe('deleted');
  });
});
