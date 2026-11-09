/**
 * Connected agents on Settings › Dispatcher (#3046, the list from #2815): one
 * list across projects of every agent that can connect to the Dispatcher, with
 * its Connect switch as its own Dispatcher card shows it.
 *
 * The switch is the agent's `connectToDispatcher`, read through the same
 * resolved policy the wires come from (dispatcher-wire-source), so the list
 * and each agent's card always agree. Changing it goes through the same
 * setOrchestrationPolicy call the card makes; nothing here writes.
 *
 * Listed: local durable agents that aren't helpers or disposed. Helpers talk
 * only to the agent that started them, so they never connect.
 */
import * as projectStore from '../project-store';
import { listDurable } from '../agent-config';
import { resolveOrchestrationPolicies } from '../orchestration-policy';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { appLog } from '../log-service';
import { readAgentCardView } from './dispatcher-agent-card-source';
import { isDispatcherPath } from './dispatcher-paths';
import type { ConnectableAgent } from '../../../shared/dispatcher-settings-page';
import type { DurableAgentConfig, Project } from '../../../shared/types';
import type { ResolvedOrchestrationPolicy } from '../../../shared/orchestration-policy';

export interface ConnectedAgentsDeps {
  listProjects?: () => Promise<Project[]>;
  listAgents?: (projectPath: string) => Promise<DurableAgentConfig[]>;
  policies?: (projectPath: string, agents: DurableAgentConfig[]) => Promise<Map<string, ResolvedOrchestrationPolicy>>;
  purposeOf?: (agentId: string) => Promise<string | undefined>;
}

async function cardPurpose(agentId: string): Promise<string | undefined> {
  const view = await readAgentCardView(agentId);
  return view?.state === 'ready' ? view.card?.purpose?.trim() || undefined : undefined;
}

/** Every agent that can connect, by project then agent name. A project that can't be read is left out for now. */
export async function listConnectableAgents(deps: ConnectedAgentsDeps = {}): Promise<ConnectableAgent[]> {
  const projects = await (deps.listProjects ?? projectStore.list)();
  const out: ConnectableAgent[] = [];
  for (const project of projects) {
    if (isDispatcherPath(project.path)) continue;
    try {
      const agents = (await (deps.listAgents ?? listDurable)(project.path))
        .filter((a) => !isDisposedAgent(a) && !a.parentAgentId);
      if (agents.length === 0) continue;
      const policies = await (deps.policies ?? resolveOrchestrationPolicies)(project.path, agents);
      const projectName = project.displayName || project.name;
      for (const agent of agents) {
        const policy = policies.get(agent.id);
        if (!policy) continue;
        const connected = !!policy.connectToDispatcher;
        let purpose: string | undefined;
        if (connected) {
          try {
            purpose = await (deps.purposeOf ?? cardPurpose)(agent.id);
          } catch {
            // telemetry-exempt: the row shows without its description.
          }
        }
        out.push({
          projectId: project.id,
          projectPath: project.path,
          projectName,
          agentId: agent.id,
          name: agent.name,
          ...(agent.color ? { color: agent.color } : {}),
          ...(agent.emoji ? { emoji: agent.emoji } : {}),
          connected,
          ...(purpose ? { purpose } : {}),
        });
      }
    } catch (err) {
      // telemetry-exempt: that project's agents are left out of the list until it can be read; logged.
      appLog('core:dispatcher', 'warn', 'Connected agents: a project could not be read', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return out.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
}
