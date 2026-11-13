/**
 * The bind handler's group project decision (#3355, #3357), run against the
 * real host and the real membership record: what a drawn or restored wire does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';
import type { GroupProject } from '../../shared/group-project-types';
import { MCP_BIND_RESTORE } from '../../shared/mcp-unbind';

const fx = vi.hoisted(() => ({
  home: '',
  projects: [] as Array<{ id: string; name: string; path: string }>,
  configs: new Map<string, DurableAgentConfig[]>(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fx.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => fx.projects),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => fx.configs.get(projectPath) ?? []),
  peekDurableConfigsChecked: vi.fn(async (projectPath: string) => ({ agents: fx.configs.get(projectPath) ?? [], readable: true })),
  onAgentConfigChanged: vi.fn(() => () => undefined),
}));
vi.mock('./quick-agent-events', () => ({ knownQuickAgents: () => new Map() }));
vi.mock('./canvas-store-reader', () => ({ readAllCanvasStores: async () => [] }));
vi.mock('./canvas-wire-source', () => ({
  canvasWireBindingSource: { id: 'canvas-wires', collect: async () => [], inspect: async () => [] },
}));
vi.mock('./group-project-bulletin', () => ({
  getBulletinBoard: vi.fn(), ensureInboxChannel: vi.fn(), ensureProjectChannels: vi.fn(), destroyBulletinBoard: vi.fn(),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { _resetPersistedBindingSourcesForTesting, rebuildPersistedBindings, registerPersistedBindingSource } from './persisted-bindings';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import { _resetMembershipForTesting, excludeMember, membershipBindingSource, reconcileMembership } from './group-project-membership';
import { bindToGroupProject } from './group-project-bind';

const PROJ_A = { id: 'proj_a', name: 'Alpha', path: path.join('work', 'alpha') };
const PROJ_B = { id: 'proj_b', name: 'Beta', path: path.join('work', 'beta') };

const agent = (id: string): DurableAgentConfig => ({ id, name: id, color: 'emerald', createdAt: '2026-01-01T00:00:00.000Z' }) as DurableAgentConfig;

function gp(id: string): GroupProject {
  return {
    id, name: `GP ${id}`, description: '', instructions: '', metadata: {},
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    scope: { level: 'project', projectId: PROJ_A.id, reach: 'local' },
  };
}

const membersOf = (gpId: string) => bindingManager.getAllBindings()
  .filter((b) => b.targetKind === 'group-project' && b.targetId === gpId).map((b) => b.agentId).sort();

async function start(): Promise<void> {
  registerPersistedBindingSource(membershipBindingSource);
  await rebuildPersistedBindings();
  await vi.waitFor(async () => {
    const m = await groupProjectHost.getMembership('gp1');
    expect(m.autoJoin || m.autoJoinOffer !== undefined).toBe(true);
  });
  await reconcileMembership();
}

function reset(): void {
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetMembershipForTesting();
  groupProjectHost._resetForTesting();
}

/** The handler's call, with its direct bind for wire-membership group projects. */
const draw = (agentId: string) => bindToGroupProject('gp1', agentId, undefined, {
  bindNow: () => { bindingManager.bind(agentId, { targetId: 'gp1', targetKind: 'group-project', label: 'GP' }); },
});
const restore = (agentId: string) => bindToGroupProject('gp1', agentId, MCP_BIND_RESTORE, {
  bindNow: () => { bindingManager.bind(agentId, { targetId: 'gp1', targetKind: 'group-project', label: 'GP' }); },
});

beforeEach(async () => {
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  fx.home = await fsp.mkdtemp(path.join(cache, 'gp-bind-'));
  fx.projects = [PROJ_A, PROJ_B];
  fx.configs = new Map([[PROJ_A.path, [agent('lead'), agent('dev')]], [PROJ_B.path, [agent('other')]]]);
  groupProjectRegistry._resetForTesting();
  reset();
  groupProjectRegistry._setForTesting(gp('gp1'));
  await start();
});

afterEach(async () => {
  reset();
  groupProjectRegistry._resetForTesting();
  await fsp.rm(fx.home, { recursive: true, force: true });
});

describe('binding a wire to a group project (real host and membership record)', () => {
  it('deleting a wire excludes the agent, and drawing it again makes it a member again', async () => {
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    // Deleting the wire (the UNBIND handler's path for a managed group project).
    await excludeMember('gp1', 'dev');
    expect(membersOf('gp1')).toEqual(['lead']);
    // The canvas restoring the deleted wire is refused: excluded.
    expect(await restore('dev')).toEqual({ notMember: true, reason: 'out_of_scope' });
    // The person draws it again: in scope, so the exclusion is lifted and it's a member.
    expect(await draw('dev')).toBeUndefined();
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    expect((await groupProjectHost.getMembership('gp1')).excluded).toEqual([]);
  });

  it('refuses a drawn wire outside the scope, remembers it, and refuses its restore', async () => {
    expect(await draw('other')).toEqual({ notMember: true, reason: 'out_of_scope' });
    expect(membersOf('gp1')).not.toContain('other');
    expect((await groupProjectHost.getMembership('gp1')).excluded).toEqual([expect.objectContaining({ address: 'other', reason: 'scope' })]);
    expect(await restore('other')).toEqual({ notMember: true, reason: 'out_of_scope' });
    // Drawing again doesn't lift a scope refusal.
    expect(await draw('other')).toEqual({ notMember: true, reason: 'out_of_scope' });
  });

  it('lets a scope-refused agent join once the scope is widened to cover it', async () => {
    expect(await draw('other')).toEqual({ notMember: true, reason: 'out_of_scope' });
    const wide = { level: 'app', reach: 'local' } as const;
    expect((await groupProjectHost.previewScope('gp1', wide)).returning).toEqual([{ address: 'other', name: 'other', projectId: 'proj_b' }]);
    await groupProjectHost.setScope('gp1', wide);
    expect((await groupProjectHost.getMembership('gp1')).excluded).toEqual([]);
    expect(await draw('other')).toBeUndefined();
    expect(membersOf('gp1')).toContain('other');
  });
});
