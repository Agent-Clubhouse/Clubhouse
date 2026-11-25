import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../agentStore';
import { useAnnexClientStore, type SatelliteConnection } from '../annexClientStore';
import { namespacedAgentId, namespacedProjectId, useRemoteProjectStore } from '../remoteProjectStore';

const projectId = namespacedProjectId('satellite', 'project');
const agentId = namespacedAgentId('satellite', 'agent');
const remoteAgent: Agent = {
  id: agentId, projectId, name: 'Remote agent', kind: 'durable', status: 'sleeping', color: 'indigo',
};
const satellite: SatelliteConnection = {
  id: 'satellite', fingerprint: 'fingerprint', alias: 'Satellite', state: 'connected',
  icon: '', color: 'indigo', host: 'host', mainPort: 1, pairingPort: 2, snapshot: null, lastError: null,
};

describe('restoring the saved project agent', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: {}, activeAgentId: null, agentSettingsOpenFor: null, projectActiveAgent: {} });
    useRemoteProjectStore.setState({ remoteAgents: { [agentId]: remoteAgent } });
    useAnnexClientStore.setState({ satellites: [satellite] });
  });

  it('preserves a just-selected remote agent through the project-switch restore', () => {
    useAgentStore.getState().setActiveAgent(agentId, projectId);
    useAgentStore.getState().restoreProjectAgent(projectId);
    expect(useAgentStore.getState().activeAgentId).toBe(agentId);
    expect(useAgentStore.getState().agents[agentId]).toBeUndefined();
  });

  it('still restores a saved local agent', () => {
    const local = { ...remoteAgent, id: 'local-agent', projectId: 'local-project' };
    useAgentStore.setState({ agents: { [local.id]: local }, projectActiveAgent: { [local.projectId]: local.id } });
    useAgentStore.getState().restoreProjectAgent(local.projectId);
    expect(useAgentStore.getState().activeAgentId).toBe(local.id);
  });

  it('clears the selection when no agent was saved', () => {
    useAgentStore.setState({ activeAgentId: agentId });
    useAgentStore.getState().restoreProjectAgent(projectId);
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });

  it('clears a deleted remote agent without falling back to a local entry', () => {
    useAgentStore.getState().setActiveAgent(agentId, projectId);
    useRemoteProjectStore.getState().removeRemoteAgent('satellite', 'agent');
    useAgentStore.setState({ agents: { [agentId]: remoteAgent } });
    useAgentStore.getState().restoreProjectAgent(projectId);
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });

  it.each(['disconnected', 'connecting', 'discovering'] as const)('clears a cached remote selection when its host is %s', (state) => {
    useAgentStore.getState().setActiveAgent(agentId, projectId);
    useAnnexClientStore.setState({ satellites: [{ ...satellite, state }] });
    expect(useRemoteProjectStore.getState().remoteAgents[agentId]).toBe(remoteAgent);
    useAgentStore.getState().restoreProjectAgent(projectId);
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });

  it('clears a remote selection when its host is no longer present', () => {
    useAgentStore.getState().setActiveAgent(agentId, projectId);
    useAnnexClientStore.setState({ satellites: [] });
    useAgentStore.getState().restoreProjectAgent(projectId);
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });

  it('does not restore a remote agent from another project or host', () => {
    const otherProject = namespacedProjectId('another-satellite', 'project');
    useAgentStore.getState().setActiveAgent(agentId, otherProject);
    useAgentStore.getState().restoreProjectAgent(otherProject);
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });
});
