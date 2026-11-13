import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '', bindings: [] as Array<{ agentId: string; agentName: string; targetId: string; targetKind: string }> }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fixture.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => null }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => []), peekProjectsChecked: vi.fn(async () => ({ readable: true, projects: [] })) }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => fixture.bindings } }));
vi.mock('../telemetry/persist', () => ({ persist: { timed: async (_kind: string, operation: () => Promise<unknown>) => operation() } }));

import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectHost } from './group-project-host';
import { createLocalGroupProjectDeleteService } from './group-project-delete-service';
import { globalCanvasKvDir } from './canvas-store-reader';

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'group-project-stores-'));
  fixture.bindings = [];
  groupProjectRegistry._resetForTesting(); _resetAllBoardsForTesting(); groupProjectHost._resetForTesting();
});
afterEach(async () => {
  groupProjectRegistry._resetForTesting(); _resetAllBoardsForTesting(); groupProjectHost._resetForTesting();
  await fs.rm(fixture.home, { recursive: true, force: true });
});

it('removes the host stores, bindings and references from every canvas while retaining other projects', async () => {
  const project = await groupProjectHost.create('Delete me');
  const other = await groupProjectHost.create('Keep me');
  await groupProjectHost.post(project.id, 'Ada', 'plans', 'A board message');
  await groupProjectHost.updateMembership(project.id, (m) => { m.excluded.push({ address: 'other-agent', excludedAt: new Date().toISOString() }); });
  fixture.bindings = [{ agentId: 'ada', agentName: 'Ada', targetId: project.id, targetKind: 'group-project' }];
  const card = (id: string, target: string) => ({ id, type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: target } });
  const canvases = [{ id: 'one', name: 'One', views: [card('a', project.id), card('keep', other.id)] }, { id: 'two', name: 'Two', views: [card('b', project.id)] }];
  const wires = [{ agentId: 'ada', targetId: project.id, targetKind: 'group-project', label: 'Ada' }];
  const dir = globalCanvasKvDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'canvas-instances.json'), JSON.stringify(canvases));
  await fs.writeFile(path.join(dir, 'canvas-wires.json'), JSON.stringify(wires));
  const release = vi.fn((id: string) => { fixture.bindings = fixture.bindings.filter((b) => b.targetId !== id); });
  const service = createLocalGroupProjectDeleteService(release);
  const preview = await service.preview(project.id, 1);
  expect(preview.canvases).toEqual(['Home / One', 'Home / Two']);
  expect(preview.members).toEqual(['Ada (ada)']);
  expect(preview.exclusions).toEqual(['other-agent']);
  expect(preview.messages).toBeGreaterThanOrEqual(1);
  await service.confirm(project.id, 1, preview.token);
  for (const file of ['canvas-instances.json', 'canvas-instances.json.bak', 'canvas-wires.json', 'canvas-wires.json.bak']) {
    const contents = await fs.readFile(path.join(dir, file), 'utf8');
    expect(contents).not.toContain(project.id);
    if (file.startsWith('canvas-instances')) expect(contents).toContain(other.id);
  }
  expect(fixture.bindings).toEqual([]);
  expect(await groupProjectHost.get(project.id)).toBeNull();
  expect(await groupProjectHost.get(other.id)).not.toBeNull();
  await expect(fs.stat(path.join(fixture.home, '.clubhouse-dev', 'group-projects', project.id))).rejects.toMatchObject({ code: 'ENOENT' });
});
