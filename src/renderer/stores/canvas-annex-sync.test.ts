/**
 * Tests for canvas-over-annex state synchronization.
 *
 * Verifies that:
 * - Snapshot canvas views are properly namespaced for remote agents
 * - Agent status updates (wake/sleep) propagate correctly
 * - Group project member resolution works for remote contexts
 * - Plugin annex compatibility is correctly determined
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useRemoteProjectStore,
  namespacedAgentId,
  namespacedProjectId,
} from './remoteProjectStore';
import type { SatelliteSnapshot } from '../../shared/types';

// Mock plugin store
const mockPluginStoreState = {
  plugins: {
    hub: { manifest: { id: 'hub', version: '1.0.0' }, source: 'builtin' },
    'group-project': { manifest: { id: 'group-project', version: '0.1.0' }, source: 'builtin' },
    canvas: { manifest: { id: 'canvas', version: '1.0.0' }, source: 'builtin' },
  },
};

vi.mock('../plugins/plugin-store', () => {
  const store = () => mockPluginStoreState;
  store.getState = () => mockPluginStoreState;
  store.setState = vi.fn();
  store.subscribe = vi.fn();
  store.destroy = vi.fn();
  return { usePluginStore: store };
});

const SAT_ID = 'AA:BB:CC:DD';

function makeCanvasSnapshot(overrides: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot {
  return {
    projects: [{ id: 'proj-1', name: 'Project 1', path: '/home/user/project' }],
    agents: {
      'proj-1': [
        { id: 'agent-a', name: 'Agent A', kind: 'durable', status: 'running', projectId: 'proj-1', color: '#ff0000' } as any,
        { id: 'agent-b', name: 'Agent B', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: '#00ff00' } as any,
      ],
    },
    quickAgents: {},
    theme: {},
    orchestrators: {},
    pendingPermissions: [],
    lastSeq: 0,
    ...overrides,
  };
}

describe('canvas-over-annex state sync', () => {
  beforeEach(() => {
    useRemoteProjectStore.setState({
      satelliteProjects: {},
      remoteAgents: {},
      remoteAgentDetailedStatus: {},
      pluginMatchState: {},
      remoteProjectIcons: {},
      remoteAgentIcons: {},
      remoteCanvasState: {},
      remoteAppCanvasState: {},
      remoteGroupProjects: {},
      remoteBulletinDigests: {},
      remoteGroupProjectMembers: {},
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Issue 1: Canvas view IDs must be namespaced so AgentCanvasView can
  // resolve remote agents from the store.
  // ─────────────────────────────────────────────────────────────────────

  describe('snapshot canvas view namespacing (fixes "always connecting")', () => {
    it('agent canvas views resolve to namespaced IDs matching remoteAgents store', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Main',
              views: [
                { id: 'v1', type: 'agent', agentId: 'agent-a', projectId: 'proj-1' },
                { id: 'v2', type: 'agent', agentId: 'agent-b', projectId: 'proj-1' },
              ],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 2, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      const state = useRemoteProjectStore.getState();
      const canvasState = state.remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')];
      const views = (canvasState.canvases[0] as any).views;

      // Canvas view agentIds should now match the keys in remoteAgents
      const nsAgentA = namespacedAgentId(SAT_ID, 'agent-a');
      const nsAgentB = namespacedAgentId(SAT_ID, 'agent-b');

      expect(views[0].agentId).toBe(nsAgentA);
      expect(views[1].agentId).toBe(nsAgentB);

      // Verify these IDs actually exist in the agent store
      expect(state.remoteAgents[nsAgentA]).toBeDefined();
      expect(state.remoteAgents[nsAgentB]).toBeDefined();

      // Simulate what AgentCanvasView does: agents.find(a => a.id === view.agentId)
      const allAgents = Object.values(state.remoteAgents);
      expect(allAgents.find(a => a.id === views[0].agentId)).toBeDefined();
      expect(allAgents.find(a => a.id === views[1].agentId)).toBeDefined();
    });

    it('agent canvas view status matches store agent status', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Main',
              views: [{ id: 'v1', type: 'agent', agentId: 'agent-a' }],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      const state = useRemoteProjectStore.getState();
      const views = (state.remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')].canvases[0] as any).views;
      const agent = state.remoteAgents[views[0].agentId];

      // agent-a is 'running' in the snapshot
      expect(agent.status).toBe('running');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Issue 2: Group project member count — metadata.projectId must be
  // namespaced so useRemoteProject detects remote context.
  // ─────────────────────────────────────────────────────────────────────

  describe('group project metadata namespacing (fixes wrong agent count)', () => {
    it('plugin widget metadata.projectId is namespaced for remote detection', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Canvas',
              views: [{
                id: 'v1', type: 'plugin',
                metadata: {
                  projectId: 'proj-1',
                  groupProjectId: 'gp-1',
                  name: 'My Group',
                },
              }],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
        groupProjectMembers: {
          'gp-1': [
            { agentId: 'agent-a', agentName: 'Agent A', status: 'connected' },
            { agentId: 'agent-b', agentName: 'Agent B', status: 'connected' },
          ],
        },
      }));

      const state = useRemoteProjectStore.getState();
      const views = (state.remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')].canvases[0] as any).views;
      const meta = views[0].metadata;

      // metadata.projectId should be namespaced — this is what useRemoteProject
      // checks to determine isRemote. Without namespacing, it falls back to
      // local bindings and shows wrong member count.
      expect(meta.projectId).toBe(namespacedProjectId(SAT_ID, 'proj-1'));
      expect(meta.projectId.startsWith('remote||')).toBe(true);

      // metadata.groupProjectId should also be namespaced for member lookup
      expect(meta.groupProjectId).toBe(`remote||${SAT_ID}||gp-1`);

      // Verify member data is accessible with correct key
      // The widget resolves: bareId = groupProjectId.split('||').pop() → 'gp-1'
      // key = `${satelliteId}::${bareId}` → `${SAT_ID}::gp-1`
      const members = state.remoteGroupProjectMembers[`${SAT_ID}::gp-1`];
      expect(members).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Issue 3: Plugin annex approval — group-project must appear in
  // pluginMatchState with annexEnabled: true.
  // ─────────────────────────────────────────────────────────────────────

  describe('plugin annex approval (fixes "not approved for annex")', () => {
    it('group-project plugin is recognized with annexEnabled when satellite reports it', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        plugins: [
          { id: 'group-project', name: 'Group Project', version: '0.1.0', scope: 'dual', annexEnabled: true },
          { id: 'canvas', name: 'Canvas', version: '1.0.0', scope: 'dual', annexEnabled: true },
        ],
      }));

      const matches = useRemoteProjectStore.getState().pluginMatchState[SAT_ID];
      const gpMatch = matches.find(p => p.id === 'group-project');

      expect(gpMatch).toBeDefined();
      expect(gpMatch!.annexEnabled).toBe(true);
      expect(gpMatch!.status).toBe('matched');
    });

    it('plugins without annexEnabled flag default to false (old satellites)', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        plugins: [
          { id: 'group-project', name: 'Group Project', version: '0.1.0', scope: 'dual' } as any,
        ],
      }));

      const matches = useRemoteProjectStore.getState().pluginMatchState[SAT_ID];
      expect(matches[0].annexEnabled).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Issue 4: Agent wake/sleep state sync — updateRemoteAgentRunState
  // must correctly update agent status when agent:woken events arrive.
  // ─────────────────────────────────────────────────────────────────────

  describe('agent wake state sync (fixes "sleeping" after wake)', () => {
    it('agent:woken event updates agent from sleeping to running', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-b', name: 'Agent B', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: '#00ff00' } as any,
          ],
        },
      }));

      // Verify initial sleeping state
      const nsId = namespacedAgentId(SAT_ID, 'agent-b');
      expect(useRemoteProjectStore.getState().remoteAgents[nsId].status).toBe('sleeping');

      // Simulate agent:woken event handler
      useRemoteProjectStore.getState().updateRemoteAgentRunState(SAT_ID, 'agent-b', 'running');

      expect(useRemoteProjectStore.getState().remoteAgents[nsId].status).toBe('running');
    });

    it('pty:exit event updates agent from running to sleeping', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot());

      const nsId = namespacedAgentId(SAT_ID, 'agent-a');
      expect(useRemoteProjectStore.getState().remoteAgents[nsId].status).toBe('running');

      // Simulate pty:exit event handler
      useRemoteProjectStore.getState().updateRemoteAgentRunState(SAT_ID, 'agent-a', 'sleeping');

      expect(useRemoteProjectStore.getState().remoteAgents[nsId].status).toBe('sleeping');
    });

    it('snapshot refresh after wake preserves running status', () => {
      const store = useRemoteProjectStore.getState();

      // Initial snapshot: agent sleeping
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-b', name: 'Agent B', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: '#00ff00' } as any,
          ],
        },
      }));

      // Agent woken
      store.updateRemoteAgentRunState(SAT_ID, 'agent-b', 'running');

      // Snapshot refresh (should have agent as running since pty started)
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-b', name: 'Agent B', kind: 'durable', status: 'running', projectId: 'proj-1', color: '#00ff00' } as any,
          ],
        },
      }));

      const nsId = namespacedAgentId(SAT_ID, 'agent-b');
      expect(useRemoteProjectStore.getState().remoteAgents[nsId].status).toBe('running');
    });

    it('canvas view + agent status are consistent after wake sequence', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-b', name: 'Agent B', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: '#00ff00' } as any,
          ],
        },
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Main',
              views: [{ id: 'v1', type: 'agent', agentId: 'agent-b' }],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      // Wake the agent
      store.updateRemoteAgentRunState(SAT_ID, 'agent-b', 'running');

      const state = useRemoteProjectStore.getState();
      const views = (state.remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')].canvases[0] as any).views;
      const viewAgentId = views[0].agentId;

      // The view's namespaced agentId should find the agent in the store
      const agent = state.remoteAgents[viewAgentId];
      expect(agent).toBeDefined();
      expect(agent.status).toBe('running');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // App-level canvas sync
  // ─────────────────────────────────────────────────────────────────────

  describe('app-level canvas sync', () => {
    it('app canvas views are namespaced in snapshot', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        appCanvasState: {
          canvases: [{
            id: 'ac1', name: 'App Canvas',
            views: [
              { id: 'v1', type: 'agent', agentId: 'agent-a', projectId: 'proj-1',
                metadata: { agentId: 'agent-a', projectId: 'proj-1' } },
              { id: 'v2', type: 'plugin',
                metadata: { groupProjectId: 'gp-1' } },
            ],
            viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 2, zoomedViewId: null,
          }],
          activeCanvasId: 'ac1',
        },
      }));

      const appState = useRemoteProjectStore.getState().remoteAppCanvasState[SAT_ID];
      const views = (appState.canvases[0] as any).views;

      // Agent view
      expect(views[0].agentId).toBe(namespacedAgentId(SAT_ID, 'agent-a'));
      expect(views[0].projectId).toBe(namespacedProjectId(SAT_ID, 'proj-1'));
      expect(views[0].metadata.agentId).toBe(namespacedAgentId(SAT_ID, 'agent-a'));

      // Plugin view with group project
      expect(views[1].metadata.groupProjectId).toBe(`remote||${SAT_ID}||gp-1`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles canvases with no views array', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Empty Canvas',
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      const canvasState = useRemoteProjectStore.getState().remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')];
      expect(canvasState).toBeDefined();
      expect(canvasState.canvases).toHaveLength(1);
    });

    it('handles views with non-string agentId gracefully', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot(SAT_ID, 'Satellite', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Canvas',
              views: [
                { id: 'v1', type: 'agent', agentId: null },
                { id: 'v2', type: 'agent', agentId: 123 },
              ],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 2, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      const canvasState = useRemoteProjectStore.getState().remoteCanvasState[namespacedProjectId(SAT_ID, 'proj-1')];
      const views = (canvasState.canvases[0] as any).views;
      // Non-string values should not be namespaced
      expect(views[0].agentId).toBeNull();
      expect(views[1].agentId).toBe(123);
    });

    it('multiple satellites maintain independent canvas state', () => {
      const store = useRemoteProjectStore.getState();

      store.applySatelliteSnapshot('sat-1', 'Satellite 1', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Canvas 1',
              views: [{ id: 'v1', type: 'agent', agentId: 'agent-a' }],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      store.applySatelliteSnapshot('sat-2', 'Satellite 2', makeCanvasSnapshot({
        canvasState: {
          'proj-1': {
            canvases: [{
              id: 'c1', name: 'Canvas 2',
              views: [{ id: 'v1', type: 'agent', agentId: 'agent-a' }],
              viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
            }],
            activeCanvasId: 'c1',
          },
        },
      }));

      const state = useRemoteProjectStore.getState();
      const cs1 = state.remoteCanvasState[namespacedProjectId('sat-1', 'proj-1')];
      const cs2 = state.remoteCanvasState[namespacedProjectId('sat-2', 'proj-1')];

      // Same raw agentId should resolve to different namespaced IDs
      const views1 = (cs1.canvases[0] as any).views;
      const views2 = (cs2.canvases[0] as any).views;
      expect(views1[0].agentId).toBe(namespacedAgentId('sat-1', 'agent-a'));
      expect(views2[0].agentId).toBe(namespacedAgentId('sat-2', 'agent-a'));
      expect(views1[0].agentId).not.toBe(views2[0].agentId);
    });
  });
});
