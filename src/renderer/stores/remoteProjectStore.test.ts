import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRemoteProjectStore, namespacedAgentId, parseNamespacedId, isRemoteAgentId, isRemoteProjectId } from './remoteProjectStore';
import type { SatelliteSnapshot } from '../../shared/types';

// Mock plugin store — need to provide a zustand-compatible getState
const mockPluginStoreState = {
  plugins: {
    hub: { manifest: { id: 'hub', version: '1.0.0' }, source: 'builtin' },
    terminal: { manifest: { id: 'terminal', version: '1.0.0' }, source: 'builtin' },
    files: { manifest: { id: 'files', version: '1.0.0' }, source: 'builtin' },
    'community-plugin': { manifest: { id: 'community-plugin', version: '1.0.0' }, source: 'community' },
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

function makeSnapshot(overrides: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot {
  return {
    projects: [
      { id: 'proj-1', name: 'My Project', path: '/home/user/project' },
    ],
    agents: {
      'proj-1': [
        { id: 'agent-1', name: 'mega-camel', kind: 'durable', status: 'running', projectId: 'proj-1', color: 'blue' } as any,
        { id: 'agent-2', name: 'swift-fox', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: 'green' } as any,
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

describe('remoteProjectStore', () => {
  beforeEach(() => {
    // Reset store state
    useRemoteProjectStore.setState({
      satelliteProjects: {},
      remoteAgents: {},
      remoteAgentDetailedStatus: {},
      pluginMatchState: {},
      remoteProjectIcons: {},
      remoteAgentIcons: {},
    });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  describe('namespacedAgentId', () => {
    it('produces remote||satelliteId||agentId format', () => {
      expect(namespacedAgentId('sat-1', 'agent-1')).toBe('remote||sat-1||agent-1');
    });
  });

  describe('parseNamespacedId', () => {
    it('parses valid namespaced ID', () => {
      expect(parseNamespacedId('remote||sat-1||agent-1')).toEqual({ satelliteId: 'sat-1', agentId: 'agent-1' });
    });

    it('correctly parses fingerprints with colons as satelliteId', () => {
      const fp = '09:3f:0e:f6:61:95:a4:57:ab:15:b5:df:c2:0b:87:f0';
      const agentId = 'durable_1773808108862_xcde48';
      const nsId = namespacedAgentId(fp, agentId);
      const parsed = parseNamespacedId(nsId);
      expect(parsed).toEqual({ satelliteId: fp, agentId });
    });

    it('returns null for non-namespaced ID', () => {
      expect(parseNamespacedId('agent-1')).toBeNull();
    });

    it('returns null for old colon-separated format', () => {
      expect(parseNamespacedId('remote:sat-1:agent-1')).toBeNull();
    });
  });

  describe('isRemoteAgentId', () => {
    it('returns true for remote IDs', () => {
      expect(isRemoteAgentId('remote||sat||agent')).toBe(true);
    });
    it('returns false for local IDs', () => {
      expect(isRemoteAgentId('agent-1')).toBe(false);
    });
  });

  describe('isRemoteProjectId', () => {
    it('returns true for remote project IDs', () => {
      expect(isRemoteProjectId('remote||sat||proj')).toBe(true);
    });
    it('returns false for local project IDs', () => {
      expect(isRemoteProjectId('proj-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // applySatelliteSnapshot
  // -------------------------------------------------------------------------

  describe('applySatelliteSnapshot', () => {
    it('namespaces project IDs', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());

      const projects = useRemoteProjectStore.getState().satelliteProjects['sat-1'];
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('remote||sat-1||proj-1');
      expect(projects[0].remote).toBe(true);
      expect(projects[0].satelliteId).toBe('sat-1');
      expect(projects[0].satelliteName).toBe('My Satellite');
      expect(projects[0].path).toBe('__remote__');
    });

    it('namespaces agent IDs and includes projectId', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());

      const agents = useRemoteProjectStore.getState().remoteAgents;
      expect(Object.keys(agents)).toHaveLength(2);
      expect(agents['remote||sat-1||agent-1']).toBeDefined();
      expect(agents['remote||sat-1||agent-1'].projectId).toBe('remote||sat-1||proj-1');
      expect(agents['remote||sat-1||agent-2'].projectId).toBe('remote||sat-1||proj-1');
    });

    it('computes plugin match state from snapshot plugins', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        plugins: [
          { id: 'hub', name: 'Hub', version: '1.0.0', scope: 'app' },
          { id: 'files', name: 'Files', version: '2.0.0', scope: 'project' }, // version mismatch
          { id: 'canvas', name: 'Canvas', version: '1.0.0', scope: 'project' }, // not installed locally
        ],
      }));

      const matchState = useRemoteProjectStore.getState().pluginMatchState['sat-1'];
      expect(matchState).toHaveLength(3);
      expect(matchState.find((p) => p.id === 'hub')?.status).toBe('matched');
      expect(matchState.find((p) => p.id === 'files')?.status).toBe('version_mismatch');
      expect(matchState.find((p) => p.id === 'canvas')?.status).toBe('missing');
    });

    it('stores project icon data URLs with namespaced keys', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        projectIcons: { 'proj-1': 'data:image/png;base64,abc123' },
      }));

      const icons = useRemoteProjectStore.getState().remoteProjectIcons;
      expect(icons['remote||sat-1||proj-1']).toBe('data:image/png;base64,abc123');
    });

    it('stores agent icon data URLs with namespaced keys', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        agentIcons: { 'agent-1': 'data:image/png;base64,xyz789' },
      }));

      const icons = useRemoteProjectStore.getState().remoteAgentIcons;
      expect(icons['remote||sat-1||agent-1']).toBe('data:image/png;base64,xyz789');
    });

    it('replaces previous satellite data on re-snapshot', () => {
      const store = useRemoteProjectStore.getState();

      // First snapshot
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());
      expect(Object.keys(useRemoteProjectStore.getState().remoteAgents)).toHaveLength(2);

      // Second snapshot with different agents
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-3', name: 'new-agent', kind: 'durable', status: 'sleeping', projectId: 'proj-1' } as any,
          ],
        },
      }));
      const agents = useRemoteProjectStore.getState().remoteAgents;
      expect(Object.keys(agents)).toHaveLength(1);
      expect(agents['remote||sat-1||agent-3']).toBeDefined();
      // Old agents should be gone
      expect(agents['remote||sat-1||agent-1']).toBeUndefined();
    });

    it('applies agentsMeta detailed statuses from snapshot', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        agentsMeta: {
          'agent-1': {
            executionMode: 'pty',
            detailedStatus: { state: 'working', message: 'Reading file', toolName: 'Read', timestamp: 1000 },
          },
          'agent-2': {
            executionMode: 'pty',
            detailedStatus: null,
          },
        },
      }));

      const statuses = useRemoteProjectStore.getState().remoteAgentDetailedStatus;
      expect(statuses['remote||sat-1||agent-1']).toEqual({
        state: 'working',
        message: 'Reading file',
        toolName: 'Read',
        timestamp: 1000,
      });
      // agent-2 has null status — should not be stored
      expect(statuses['remote||sat-1||agent-2']).toBeUndefined();
    });

    it('clears old detailed statuses on re-snapshot', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        agentsMeta: {
          'agent-1': {
            detailedStatus: { state: 'working', message: 'Writing', timestamp: 1000 },
          },
        },
      }));
      expect(useRemoteProjectStore.getState().remoteAgentDetailedStatus['remote||sat-1||agent-1']).toBeDefined();

      // Second snapshot without agentsMeta
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());
      expect(useRemoteProjectStore.getState().remoteAgentDetailedStatus['remote||sat-1||agent-1']).toBeUndefined();
    });

    it('tracks source field as builtin for built-in plugins', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'Sat 1', makeSnapshot({
        plugins: [
          { id: 'hub', name: 'Hub', version: '1.0.0', scope: 'dual' },
        ],
      }));

      const matchState = useRemoteProjectStore.getState().pluginMatchState['sat-1'];
      expect(matchState[0].source).toBe('builtin');
    });

    it('tracks source field as community for 3P plugins', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'Sat 1', makeSnapshot({
        plugins: [
          { id: 'community-plugin', name: 'Community Plugin', version: '1.0.0', scope: 'project' },
        ],
      }));

      const matchState = useRemoteProjectStore.getState().pluginMatchState['sat-1'];
      expect(matchState[0].status).toBe('matched');
      expect(matchState[0].source).toBe('community');
    });

    it('does not set source for missing plugins', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'Sat 1', makeSnapshot({
        plugins: [
          { id: 'unknown-plugin', name: 'Unknown', version: '1.0.0', scope: 'project' },
        ],
      }));

      const matchState = useRemoteProjectStore.getState().pluginMatchState['sat-1'];
      expect(matchState[0].status).toBe('missing');
      expect(matchState[0].source).toBeUndefined();
    });

    it('keeps other satellites data when updating one', () => {
      const store = useRemoteProjectStore.getState();

      store.applySatelliteSnapshot('sat-1', 'Satellite 1', makeSnapshot());
      store.applySatelliteSnapshot('sat-2', 'Satellite 2', makeSnapshot({
        projects: [{ id: 'proj-2', name: 'Other Project', path: '/other' }],
        agents: {
          'proj-2': [
            { id: 'agent-x', name: 'other-agent', kind: 'durable', status: 'sleeping', projectId: 'proj-2' } as any,
          ],
        },
      }));

      const state = useRemoteProjectStore.getState();
      expect(state.satelliteProjects['sat-1']).toHaveLength(1);
      expect(state.satelliteProjects['sat-2']).toHaveLength(1);
      expect(state.remoteAgents['remote||sat-1||agent-1']).toBeDefined();
      expect(state.remoteAgents['remote||sat-2||agent-x']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // removeSatellite
  // -------------------------------------------------------------------------

  describe('removeSatellite', () => {
    it('removes all data for a satellite', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        projectIcons: { 'proj-1': 'data:image/png;base64,abc' },
        agentIcons: { 'agent-1': 'data:image/png;base64,xyz' },
        plugins: [{ id: 'hub', name: 'Hub', version: '1.0.0', scope: 'app' }],
      }));

      useRemoteProjectStore.getState().removeSatellite('sat-1');

      const state = useRemoteProjectStore.getState();
      expect(state.satelliteProjects['sat-1']).toBeUndefined();
      expect(Object.keys(state.remoteAgents)).toHaveLength(0);
      expect(state.pluginMatchState['sat-1']).toBeUndefined();
      expect(Object.keys(state.remoteProjectIcons)).toHaveLength(0);
      expect(Object.keys(state.remoteAgentIcons)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getAllRemoteProjects
  // -------------------------------------------------------------------------

  describe('getAllRemoteProjects', () => {
    it('returns flattened projects from all satellites', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'Sat 1', makeSnapshot());
      store.applySatelliteSnapshot('sat-2', 'Sat 2', makeSnapshot({
        projects: [{ id: 'proj-2', name: 'Project 2', path: '/p2' }],
        agents: {},
      }));

      const all = useRemoteProjectStore.getState().getAllRemoteProjects();
      expect(all).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // updateRemoteAgentStatus
  // -------------------------------------------------------------------------

  describe('updateRemoteAgentStatus', () => {
    it('stores detailed status keyed by namespaced ID', () => {
      useRemoteProjectStore.getState().updateRemoteAgentStatus('sat-1', 'agent-1', {
        state: 'needs_permission',
        message: 'Bash: rm -rf /',
      } as any);

      const status = useRemoteProjectStore.getState().remoteAgentDetailedStatus;
      expect(status['remote||sat-1||agent-1']).toBeDefined();
      expect(status['remote||sat-1||agent-1'].state).toBe('needs_permission');
      expect(status['remote||sat-1||agent-1'].message).toBe('Bash: rm -rf /');
    });

    it('overwrites previous status for the same agent', () => {
      const store = useRemoteProjectStore.getState();
      store.updateRemoteAgentStatus('sat-1', 'agent-1', { state: 'working', message: 'Reading file' } as any);
      store.updateRemoteAgentStatus('sat-1', 'agent-1', { state: 'needs_permission', message: 'Bash' } as any);

      const status = useRemoteProjectStore.getState().remoteAgentDetailedStatus;
      expect(status['remote||sat-1||agent-1'].state).toBe('needs_permission');
    });
  });

  // -------------------------------------------------------------------------
  // updateRemoteAgentRunState
  // -------------------------------------------------------------------------

  describe('updateRemoteAgentRunState', () => {
    it('updates agent status from sleeping to running', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot({
        agents: {
          'proj-1': [
            { id: 'agent-1', name: 'mega-camel', kind: 'durable', status: 'sleeping', projectId: 'proj-1', color: 'blue' } as any,
          ],
        },
      }));

      // Verify initial state
      expect(useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'].status).toBe('sleeping');

      // Update to running
      useRemoteProjectStore.getState().updateRemoteAgentRunState('sat-1', 'agent-1', 'running');

      expect(useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'].status).toBe('running');
    });

    it('updates agent status from running to sleeping', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());

      // agent-1 starts as 'running' in makeSnapshot
      expect(useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'].status).toBe('running');

      useRemoteProjectStore.getState().updateRemoteAgentRunState('sat-1', 'agent-1', 'sleeping');

      expect(useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'].status).toBe('sleeping');
    });

    it('is a no-op for unknown agent IDs', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());
      const agentsBefore = useRemoteProjectStore.getState().remoteAgents;

      useRemoteProjectStore.getState().updateRemoteAgentRunState('sat-1', 'nonexistent', 'running');

      const agentsAfter = useRemoteProjectStore.getState().remoteAgents;
      expect(agentsAfter).toEqual(agentsBefore);
    });

    it('preserves other agent fields when updating status', () => {
      const store = useRemoteProjectStore.getState();
      store.applySatelliteSnapshot('sat-1', 'My Satellite', makeSnapshot());

      const before = useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'];

      useRemoteProjectStore.getState().updateRemoteAgentRunState('sat-1', 'agent-1', 'sleeping');

      const after = useRemoteProjectStore.getState().remoteAgents['remote||sat-1||agent-1'];
      expect(after.name).toBe(before.name);
      expect(after.kind).toBe(before.kind);
      expect(after.color).toBe(before.color);
      expect(after.status).toBe('sleeping'); // Only status changed
    });
  });
});
