/**
 * A copy of a network group project that this computer shows on a Canvas
 * (#3363): when its host deleted it while this computer was offline, the copy
 * goes at the next catch-up, and so do its saved cards and wires.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fixture.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: SELF }) }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => []), peekProjectsChecked: vi.fn(async () => ({ readable: true, projects: [] })) }));
vi.mock('../telemetry/persist', () => ({ persist: { timed: async (_kind: string, operation: () => Promise<unknown>) => operation() } }));

const SELF = Array.from({ length: 32 }, () => 'aa').join(':');
const HOST = Array.from({ length: 32 }, () => 'bb').join(':');

import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting } from './group-project-bulletin';
import { groupProjectHost } from './group-project-host';
import { startGroupProjectNetwork } from './group-project-network';
import { purgeGroupProjectViews } from './group-project-delete-service';
import { globalCanvasKvDir } from './canvas-store-reader';
import { writeKey } from './plugin-storage';
import { GROUP_PROJECT_SYNC_PATH } from '../../shared/group-project-network';

let stop: (() => void) | null = null;

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'group-project-network-canvas-'));
  groupProjectRegistry._resetForTesting(); _resetAllBoardsForTesting(); groupProjectHost._resetForTesting();
});
afterEach(async () => {
  stop?.();
  stop = null;
  groupProjectRegistry._resetForTesting(); _resetAllBoardsForTesting(); groupProjectHost._resetForTesting();
  await fs.rm(fixture.home, { recursive: true, force: true });
});

it('an offline copy with a Canvas card loses the copy, the card and its wires when the host\'s delete arrives', async () => {
  // This computer's copy of the host's group project, and another group project it keeps.
  const copy = { id: 'gp_copy', name: 'Launch', description: '', instructions: '', createdAt: 't', metadata: {}, scope: { level: 'app', reach: 'network' } as const, host: { machine: HOST } };
  await groupProjectRegistry.putReplica(copy);
  const kept = await groupProjectHost.create('Keep me');
  const card = (id: string, target: string) => ({ id, type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: target } });
  const dir = globalCanvasKvDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'canvas-instances.json'), JSON.stringify([{ id: 'one', name: 'One', views: [card('a', copy.id), card('keep', kept.id)] }]));
  await fs.writeFile(path.join(dir, 'canvas-wires.json'), JSON.stringify([{ agentId: 'ada', targetId: copy.id, targetKind: 'group-project', label: 'Ada' }]));

  // The host comes back with a tombstone for it.
  stop = startGroupProjectNetwork({
    transport: {
      connected: () => true,
      machineName: () => 'Desk',
      onConnected: () => () => undefined,
      post: async (_machine, urlPath) => {
        expect(urlPath).toBe(GROUP_PROJECT_SYNC_PATH);
        return { status: 200, body: { v: 1, projects: [], unchanged: [], tombstones: [{ groupProjectId: copy.id, seq: 9, deletedAt: 't' }] } };
      },
    },
    isMember: () => true,
    members: () => [],
    onMembershipChanged: () => () => undefined,
    purgeViews: purgeGroupProjectViews,
  });
  await groupProjectHost.syncFrom(HOST);

  expect(await groupProjectHost.get(copy.id)).toBeNull();
  await vi.waitFor(async () => {
    const instances = await fs.readFile(path.join(dir, 'canvas-instances.json'), 'utf8');
    expect(instances).not.toContain(copy.id);
    expect(instances).toContain(kept.id);
    expect(await fs.readFile(path.join(dir, 'canvas-wires.json'), 'utf8')).not.toContain(copy.id);
    // Recorded as done just after the files are written.
    expect(await groupProjectHost.pendingViewPurges()).toEqual([]);
  });

  // A save the renderer had in flight from before the purge can't bring the card or wire back.
  await writeKey({ pluginId: 'canvas', scope: 'global', key: 'canvas-instances', value: [{ id: 'one', name: 'One', views: [card('a', copy.id), card('keep', kept.id)] }] });
  await writeKey({ pluginId: 'canvas', scope: 'global', key: 'canvas-wires', value: [{ agentId: 'ada', targetId: copy.id, targetKind: 'group-project', label: 'Ada' }] });
  const saved = await fs.readFile(path.join(dir, 'canvas-instances.json'), 'utf8');
  expect(saved).not.toContain(copy.id);
  expect(saved).toContain(kept.id);
  expect(await fs.readFile(path.join(dir, 'canvas-wires.json'), 'utf8')).not.toContain(copy.id);
});

it('a failed card removal is finished on the next start', async () => {
  const copy = { id: 'gp_copy2', name: 'Launch', description: '', instructions: '', createdAt: 't', metadata: {}, scope: { level: 'app', reach: 'network' } as const, host: { machine: HOST } };
  await groupProjectRegistry.putReplica(copy);
  const dir = globalCanvasKvDir();
  await fs.mkdir(dir, { recursive: true });
  const card = { id: 'a', type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: copy.id } };
  await fs.writeFile(path.join(dir, 'canvas-instances.json'), JSON.stringify([{ id: 'one', name: 'One', views: [card] }]));
  const transport = {
    connected: () => true, machineName: () => 'Desk', onConnected: () => () => undefined,
    post: async () => ({ status: 200, body: { v: 1, projects: [], unchanged: [], tombstones: [{ groupProjectId: copy.id, seq: 9, deletedAt: 't' }] } }),
  };
  const base = { transport, isMember: () => true, members: () => [], onMembershipChanged: () => () => undefined };
  // The removal fails, and the app stops before it is retried.
  stop = startGroupProjectNetwork({ ...base, purgeViews: async () => { throw new Error('canvas busy'); } });
  await groupProjectHost.syncFrom(HOST);
  await vi.waitFor(async () => expect(await groupProjectHost.pendingViewPurges()).toEqual([copy.id]));
  stop();
  // The next start finishes it.
  stop = startGroupProjectNetwork({ ...base, purgeViews: purgeGroupProjectViews });
  await vi.waitFor(async () => {
    expect(await fs.readFile(path.join(dir, 'canvas-instances.json'), 'utf8')).not.toContain(copy.id);
    expect(await groupProjectHost.pendingViewPurges()).toEqual([]);
  });
});
