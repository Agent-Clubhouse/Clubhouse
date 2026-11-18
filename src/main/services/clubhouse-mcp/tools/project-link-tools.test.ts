import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Project } from '../../../../shared/types';
import type { AgentGrantChanges } from '../../../../shared/agent-grant-changes';
import type { SatelliteConnection } from '../../annex-client';
import type { AnnexPeer } from '../../../../shared/types';

const state = vi.hoisted(() => ({
  dir: '', projects: [] as Project[], satellites: [] as SatelliteConnection[], peers: [] as AnnexPeer[],
  changes: undefined as AgentGrantChanges | undefined,
  origins: [] as Array<{ surface: string; actorId?: string }>,
  projectListeners: [] as Array<() => void>,
}));
const B = Array(16).fill('bb').join(':');
const C = Array(16).fill('cc').join(':');
const remote = `remote||${B}||copy`;
const remote2 = `remote||${B}||other`;

vi.mock('electron', async (original) => {
  const actual = await original<typeof import('electron')>();
  return { ...actual, app: { ...actual.app, getPath: (name: string) => name === 'userData' ? state.dir : actual.app.getPath(name) } };
});
vi.mock('../../annex-client', async (original) => ({
  ...await original<typeof import('../../annex-client')>(), getSatellites: () => state.satellites,
}));
vi.mock('../../annex-identity', async (original) => ({
  ...await original<typeof import('../../annex-identity')>(),
  getIdentity: () => ({ fingerprint: Array(16).fill('aa').join(':') }),
}));
vi.mock('../../annex-peers', async (original) => ({
  ...await original<typeof import('../../annex-peers')>(), listPeers: () => state.peers,
}));
vi.mock('../../project-store', async (original) => ({
  ...await original<typeof import('../../project-store')>(),
  list: async () => state.projects,
  peekProjects: async () => state.projects,
  onProjectsChanged: (fn: () => void) => { state.projectListeners.push(fn); return () => {}; },
}));
vi.mock('../../agent-grants-store', async (original) => ({
  ...await original<typeof import('../../agent-grants-store')>(), getAgentGrantChanges: () => state.changes,
}));
vi.mock('../../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../../dispatcher/dispatcher-settings')>(), isDispatcherEnabled: () => true,
}));
vi.mock('../../settings-audit', async (original) => {
  const actual = await original<typeof import('../../settings-audit')>();
  return { ...actual, auditChanged: vi.fn(async () => { state.origins.push(actual.currentSettingsOrigin()); }) };
});
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../agent-config', async (original) => ({
  ...await original<typeof import('../../agent-config')>(), getDurableConfig: async () => ({ name: 'Dispatcher' }),
}));

import { registerProjectLinkTools } from './project-link-tools';
import { callTool, listToolGrants, getScopedToolList, _resetForTesting } from '../tool-registry';
import { registerClubhouseMcpTools } from './register-all';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from '../dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from '../mcp-call-gate';
import { agentRegistry } from '../../agent-registry';
import { _resetProjectLinksStoreForTesting, changeProjectLinks, projectLinksStore } from '../../project-links-store';
import { resetAllSettingsStoresForTests } from '../../settings-store';
import { _resetRepoKeysForTesting } from '../../project-repo-keys';
import { _resetGrantRequestsForTesting, listGrantRequests, takeGrantRequest, dropCallApprovalsFor } from '../../grant-requests';
import { withSettingsSurface } from '../../settings-audit';
import { decideGrant } from '../grant-check';
import { resolveArgTargets } from '../arg-targets';
import type { McpToolResult } from '../types';

function project(id: string): Project {
  return { id, name: id === 'site' ? 'Site' : id, path: `/work/${id}` };
}
function satellite(fingerprint = B): SatelliteConnection {
  return {
    id: fingerprint, fingerprint, alias: 'Studio', icon: 'computer', color: 'indigo', state: 'connected',
    host: 'private-host', mainPort: 1, pairingPort: 2, lastError: null,
    snapshot: { projects: [
      { id: 'copy', name: 'Site copy', repoKey: 'github.com/acme/site' },
      { id: 'other', name: 'Other copy', repoKey: 'github.com/acme/other' },
    ], agents: {}, quickAgents: {}, theme: {}, orchestrators: {}, pendingPermissions: [], lastSeq: 1 },
  };
}
function peer(fingerprint = B): AnnexPeer {
  return {
    fingerprint, alias: 'Studio', icon: 'computer', color: 'indigo', pairedAt: '', lastSeen: '',
    role: 'member', kind: 'desktop', publicKey: 'not-returned', tlsCertificateFingerprint: 'pinned',
    tlsCertificatePem: 'not-returned',
  };
}
function mode(value: 'off' | 'ask' | 'allow') {
  state.changes = { changes: [{ action: 'project.link', target: { kind: 'project', project: 'any' }, mode: value }] };
}
function text(result: McpToolResult): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}
async function body(tool = 'list_project_links', args: Record<string, unknown> = {}) {
  const result = await callTool('dispatcher', tool, args);
  expect(result.isError, text(result)).not.toBe(true);
  return JSON.parse(text(result));
}
async function ui(op: unknown) {
  return withSettingsSurface('ui', undefined, () => changeProjectLinks(op));
}
function approve() {
  const requests = listGrantRequests();
  expect(requests).toHaveLength(1);
  expect(takeGrantRequest(requests[0].requestId, true)).not.toBeNull();
}

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-link-tools-'));
  state.projects = [project('site'), project('second')];
  state.satellites = [satellite()];
  state.peers = [peer()];
  state.changes = undefined;
  state.origins = [];
  resetAllSettingsStoresForTests();
  _resetProjectLinksStoreForTesting();
  _resetGrantRequestsForTesting();
  _resetForTesting();
  _resetDispatcherGateForTesting();
  _resetMcpCallGateForTesting();
  _resetRepoKeysForTesting(async (cwd) => cwd === '/work/site' ? 'git@github.com:acme/site.git' : null);
  agentRegistry.register('dispatcher', { projectPath: '/dispatcher', orchestrator: 'claude-code', runtime: 'chat' });
  setMcpCaller('dispatcher', '/dispatcher', {});
  setDispatcherAgent('dispatcher', true);
  registerProjectLinkTools();
});
afterEach(() => {
  _resetGrantRequestsForTesting();
  _resetProjectLinksStoreForTesting();
  agentRegistry.untrack('dispatcher');
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe('Dispatcher project linking (#3704)', () => {
  it('registers all four startup tools with grants, Dispatcher gates and annotations', () => {
    _resetForTesting();
    registerClubhouseMcpTools();
    const tools = listToolGrants().filter((t) => ['list_project_links', 'link_projects', 'unlink_project', 'keep_projects_separate'].includes(t.name));
    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      expect(tool.group).toBe('dispatcher');
      expect(tool.annotations).toEqual({
        readOnlyHint: tool.name === 'list_project_links',
        destructiveHint: ['unlink_project', 'keep_projects_separate'].includes(tool.name),
        openWorldHint: false,
      });
      expect(tool.grant).toMatchObject({
        actions: [tool.name === 'list_project_links' ? 'project.read' : 'project.link'],
        target: tool.name === 'list_project_links' ? 'all_projects' : 'project_arg',
      });
    }
    expect(getScopedToolList('dispatcher').map((t) => t.name)).toEqual(expect.arrayContaining(tools.map((t) => t.name)));
  });

  it('lists safe visible ids and suggestions with the renderer matching exclusions', async () => {
    const first = await body();
    expect(first.suggestions).toEqual([{ a: 'site', b: remote, repoKey: 'github.com/acme/site' }]);
    expect(first.projects.find((p: { id: string }) => p.id === remote)).toMatchObject({ name: 'Site copy', machineId: B, local: false });
    for (const secret of ['private-host', 'publicKey', 'pinned', 'not-returned', '/work/', 'git@']) expect(JSON.stringify(first)).not.toContain(secret);
    await ui({ type: 'keepSeparate', a: 'site', b: remote });
    expect((await body()).suggestions).toEqual([]);
    await ui({ type: 'link', a: 'site', b: remote });
    const linked = await body();
    expect(linked.links).toHaveLength(1);
    expect(linked.suggestions).toEqual([]);
    expect(linked.keptSeparate).toEqual([]);
  });

  it('defaults to Ask, writes nothing before approval, and consumes approval only once', async () => {
    expect(decideGrant('dispatcher', 'project.link', { kind: 'project' }).outcome).toBe('ask');
    const args = { a: 'site', b: remote };
    const asked = await callTool('dispatcher', 'link_projects', args);
    expect(text(asked)).toContain('Not done yet');
    expect(projectLinksStore().records()).toEqual([]);
    expect(listGrantRequests()[0]).toMatchObject({ kind: 'call', actions: ['project.link'], toolName: 'link_projects' });
    expect(listGrantRequests()[0].details).toContain('Site (This computer)');
    approve();
    expect((await body('link_projects', args)).links).toHaveLength(1);
    expect(state.origins.at(-1)).toEqual({ surface: 'mcp', actorId: 'dispatcher' });
    expect(text(await callTool('dispatcher', 'link_projects', args))).toContain('Not done yet');
  });

  it('declining Ask leaves link metadata unchanged', async () => {
    await callTool('dispatcher', 'keep_projects_separate', { a: 'site', b: remote });
    const request = listGrantRequests()[0];
    takeGrantRequest(request.requestId, false);
    expect(projectLinksStore().records()).toEqual([]);
    expect(text(await callTool('dispatcher', 'keep_projects_separate', { a: 'site', b: remote }))).toContain('Not done yet');
    expect(projectLinksStore().records()).toEqual([]);
  });

  it('Off refuses every mutation, even when a prior call was approved', async () => {
    await callTool('dispatcher', 'link_projects', { a: 'site', b: remote });
    approve();
    mode('off');
    expect(getScopedToolList('dispatcher').map((t) => t.name)).not.toContain('link_projects');
    for (const [tool, args] of [
      ['link_projects', { a: 'site', b: remote }],
      ['unlink_project', { project: 'site' }],
      ['keep_projects_separate', { a: 'site', b: remote }],
    ] as const) {
      const result = await callTool('dispatcher', tool, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('project.link');
    }
    expect(projectLinksStore().records()).toEqual([]);
  });

  it('Allow uses the real service for link, group addition, unlink, keep separate and explicit relink undo', async () => {
    mode('allow');
    const changes = vi.fn();
    const stop = projectLinksStore().onChange(changes);
    expect((await body('link_projects', { a: 'site', b: remote })).links).toEqual([expect.arrayContaining(['site', remote])]);
    expect((await body('link_projects', { a: 'second', b: remote })).links[0]).toHaveLength(3);
    const unlinked = await body('unlink_project', { project: 'second' });
    expect(unlinked.links[0]).toHaveLength(2);
    expect(unlinked.keptSeparate).toHaveLength(2);
    await body('keep_projects_separate', { a: 'site', b: remote });
    expect(projectLinksStore().view().links).toEqual([]);
    expect((await body('link_projects', { a: 'site', b: remote })).keptSeparate).not.toContain([remote, 'site'].sort().join('\n'));
    expect(listGrantRequests()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(5);
    expect(changes).toHaveBeenLastCalledWith({ source: undefined, recordsChanged: true });
    stop();
    const saved = await fs.promises.readFile(path.join(state.dir, 'network-project-links.json'), 'utf8');
    expect(JSON.parse(saved).records.length).toBeGreaterThan(0);
    _resetProjectLinksStoreForTesting();
    expect(projectLinksStore().view().links).toEqual([expect.arrayContaining(['site', remote])]);
  });

  it('refuses unknown, malformed and unpaired project ids without writing', async () => {
    expect((await callTool('dispatcher', 'link_projects', { a: 'site', b: 'unknown' })).isError).toBe(true);
    expect(listGrantRequests()).toEqual([]);
    mode('allow');
    state.satellites.push(satellite(C));
    for (const id of ['unknown', '/work/site', 'Site', `remote||${C}||copy`, `remote||${B}||missing`, 'remote||bad||copy']) {
      const result = await callTool('dispatcher', 'link_projects', { a: 'site', b: id });
      expect(result.isError, id).toBe(true);
    }
    expect((await body()).projects.some((p: { machineId: string }) => p.machineId === C)).toBe(false);
    state.peers[0].networkPending = true;
    expect((await callTool('dispatcher', 'link_projects', { a: 'site', b: remote })).isError).toBe(true);
    state.peers[0].networkPending = false;
    state.satellites[0].needsPairing = true;
    expect((await callTool('dispatcher', 'link_projects', { a: 'site', b: remote })).isError).toBe(true);
    expect(projectLinksStore().records()).toEqual([]);
  });

  it('checks every member of merged groups and never treats a remote path as a local project grant', async () => {
    mode('allow');
    await body('link_projects', { a: 'site', b: remote });
    const grant = listToolGrants().find((t) => t.name === 'link_projects')!.grant;
    const targets = [...(await resolveArgTargets('dispatcher', grant, { a: 'second', b: remote })).values()].flat();
    expect(targets).toEqual(expect.arrayContaining([
      { kind: 'project', projectLinkId: 'site', projectPath: '/work/site' },
      { kind: 'project', projectLinkId: remote },
      { kind: 'project', projectLinkId: 'second', projectPath: '/work/second' },
    ]));
    state.changes = { changes: [
      { action: 'project.link', target: { kind: 'project', project: 'any' }, mode: 'off' },
      { action: 'project.link', target: { kind: 'project', project: { path: '/work/site' } }, mode: 'allow' },
      { action: 'project.link', target: { kind: 'project', project: { path: '/work/second' } }, mode: 'allow' },
    ] };
    expect((await callTool('dispatcher', 'link_projects', { a: 'second', b: remote })).isError).toBe(true);
    mode('allow');
    state.peers = [];
    expect((await callTool('dispatcher', 'unlink_project', { project: 'site' })).isError).toBe(true);
    expect(projectLinksStore().view().links[0]).toHaveLength(2);
  });

  it('requires a new approval when an affected linked group changes', async () => {
    const args = { a: 'site', b: remote };
    await callTool('dispatcher', 'link_projects', args);
    approve();
    await ui({ type: 'link', a: remote, b: remote2 });
    expect(text(await callTool('dispatcher', 'link_projects', args))).toContain('Not done yet');
    expect(projectLinksStore().view().links).toEqual([expect.arrayContaining([remote, remote2])]);
  });

  it('refuses non-Dispatcher MCP callers and direct unapproved MCP writes at the store', async () => {
    setMcpCaller('ordinary', '/work/site', {});
    expect(decideGrant('ordinary', 'project.link', { kind: 'project' })).toEqual({ outcome: 'refuse', reason: 'no_grant' });
    for (const value of ['off', 'ask', 'allow'] as const) {
      mode(value);
      expect((await callTool('ordinary', 'link_projects', { a: 'site', b: remote })).isError).toBe(true);
      await expect(withSettingsSurface('mcp', 'ordinary', () => changeProjectLinks({ type: 'link', a: 'site', b: remote }))).rejects.toThrow('Only the Dispatcher');
      await expect(withSettingsSurface('mcp', 'dispatcher', () => changeProjectLinks({ type: 'link', a: 'site', b: remote }))).rejects.toThrow('Only the Dispatcher');
    }
    expect(projectLinksStore().records()).toEqual([]);
    expect(listGrantRequests()).toEqual([]);
    // The person's existing path does not acquire an agent-only grant requirement.
    await ui({ type: 'link', a: 'site', b: remote });
    expect(projectLinksStore().view().links).toHaveLength(1);
  });

  it('refuses listing without a project.read grant and never accepts a self-pair or extra mutation arguments', async () => {
    state.changes = { changes: [{ action: 'project.read', target: { kind: 'project', project: 'any' }, mode: 'off' }] };
    expect((await callTool('dispatcher', 'list_project_links', {})).isError).toBe(true);
    for (const args of [{ a: 'site', b: 'site' }, { a: 'site', b: remote, allow: true }, { a: 'site', b: 42 }]) {
      expect((await callTool('dispatcher', 'link_projects', args)).isError).toBe(true);
    }
    expect(listGrantRequests()).toEqual([]);
    expect(projectLinksStore().records()).toEqual([]);
  });

  it.each(['off', 'approval', 'pairing', 'local project'] as const)('rechecks %s revocation at the atomic persistence boundary', async (revocation) => {
    const args = { a: 'site', b: remote };
    if (revocation === 'approval') {
      await callTool('dispatcher', 'link_projects', args);
      approve();
    } else mode('allow');
    const realOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      // The settings writer creates its temporary file after the queue-entry check.
      if (String(args[0]).includes('network-project-links') && String(args[0]).includes('.tmp')) {
        if (revocation === 'off') mode('off');
        else if (revocation === 'approval') dropCallApprovalsFor('dispatcher');
        else if (revocation === 'pairing') state.peers = [];
        else for (const listener of state.projectListeners) listener();
      }
      return realOpen(...args);
    });
    try {
      const result = await callTool('dispatcher', 'link_projects', args);
      expect(result.isError).toBe(true);
      expect(projectLinksStore().records()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('a consumed approval cannot survive explicit approval revocation', async () => {
    const args = { a: 'site', b: remote };
    await callTool('dispatcher', 'link_projects', args);
    approve();
    dropCallApprovalsFor('dispatcher');
    expect(text(await callTool('dispatcher', 'link_projects', args))).toContain('Not done yet');
    expect(projectLinksStore().records()).toEqual([]);
  });
});
