import { isMachineFingerprint } from '../../shared/agent-address';
import type { CapacityAgentCounts } from '../../shared/handoff-capacity';
import { peekDurableConfigsChecked } from './agent-config';
import { cachedProviderCapacity } from './provider-quota';
import { peekProjectsChecked, projectPathKey } from './project-store';
import { getLiveAgentActivity } from './restart-session-service';
import type { CapacitySamplingSources } from './handoff-capacity';

async function projects() {
  try {
    const inventory = await peekProjectsChecked();
    if (!inventory.readable || inventory.projects.length === 0 || inventory.projects.length > 1000) throw new Error();
    return [...new Map(inventory.projects.map((project) => [projectPathKey(project.path), project])).values()];
  } catch {
    // telemetry-exempt: explicitly unavailable, without paths or registry diagnostics
    throw new Error('Capacity inventory is unavailable.');
  }
}

async function agentCounts(): Promise<CapacityAgentCounts> {
  try {
    const durable = new Set<string>();
    const key = (project: string, agentId: string) => JSON.stringify([projectPathKey(project), agentId]);
    for (const project of await projects()) {
      const inventory = await peekDurableConfigsChecked(project.path);
      if (!inventory.readable) throw new Error();
      for (const agent of inventory.agents) durable.add(key(project.path, agent.id));
    }
    const activity = getLiveAgentActivity({ includePendingWork: true });
    const live = new Set(activity.map((agent) => key(agent.projectPath, agent.agentId)));
    return {
      running: activity.length,
      sleeping: [...durable].filter((agent) => !live.has(agent)).length,
      idleDurable: activity.filter((agent) => !agent.isWorking && durable.has(key(agent.projectPath, agent.agentId))).length,
    };
  } catch {
    // telemetry-exempt: no healthy-zero fallback when a registered project cannot be read
    throw new Error('Capacity inventory is unavailable.');
  }
}

/** Unregistered main-only sources; machine and accepting policy must come from the trusted runtime, never tool arguments. */
export function localHandoffCapacitySources(machine: string, acceptingHandoffs: () => boolean = () => false): CapacitySamplingSources {
  if (!isMachineFingerprint(machine) || machine !== machine.toLowerCase()) throw new Error('Invalid capacity machine.');
  return {
    machine,
    agentCounts,
    projectVolumes: async () => (await projects()).map((project) => project.path),
    providers: () => {
      const now = Date.now();
      return {
        'claude-code': cachedProviderCapacity('claude-code', now),
        'copilot-cli': cachedProviderCapacity('copilot-cli', now),
        'codex-cli': cachedProviderCapacity('codex-cli', now),
      };
    },
    acceptingHandoffs,
  };
}
