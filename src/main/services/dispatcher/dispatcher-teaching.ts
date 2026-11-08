/**
 * What the Dispatcher's first conversation is built from (#3048): its
 * connected agents, for the intro and the suggestions, and what it can do,
 * from its live grants, for "What else can you do?". The wording lives in
 * shared/dispatcher-teaching.ts; this file only reads the app.
 */

import * as projectStore from '../project-store';
import { listDurable } from '../agent-config';
import { resolveOrchestrationPolicies } from '../orchestration-policy';
import * as agentSystem from '../agent-system';
import { effectiveAgentGrants } from '../agent-grants-service';
import { appLog } from '../log-service';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { dispatcherCapabilities, type CapabilityGroup, type DispatcherTeaching, type TeachingAgent } from '../../../shared/dispatcher-teaching';
import { getDispatcherPath } from './dispatcher-paths';
import { getDispatcherAgentId } from './dispatcher-service';
import { isDispatcherEnabled } from './dispatcher-settings';
import { getAgentCards } from './dispatcher-agent-cards-watch';

const NS = 'core:dispatcher';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function purposeOf(agentId: string): Promise<string | undefined> {
  try {
    const view = await getAgentCards().view(agentId);
    return view?.state === 'ready' ? view.card?.purpose?.trim() || undefined : undefined;
  } catch (err) {
    // telemetry-exempt: logged; the agent is suggested without its card
    appLog(NS, 'warn', 'Teaching: could not read a card', { meta: { agentId, error: errorText(err) } });
    return undefined;
  }
}

/**
 * Every agent with Connect to Dispatcher on, across registered projects,
 * whether it is running, and what its card says it's for. An unreadable
 * project is skipped, not fatal. None while the Dispatcher is off.
 */
export async function readTeachingAgents(): Promise<TeachingAgent[]> {
  if (!isDispatcherEnabled()) return [];
  const out: TeachingAgent[] = [];
  for (const project of await projectStore.list()) {
    try {
      const agents = (await listDurable(project.path)).filter((a) => !isDisposedAgent(a));
      if (agents.length === 0) continue;
      const policies = await resolveOrchestrationPolicies(project.path, agents);
      for (const agent of agents) {
        if (!policies.get(agent.id)?.connectToDispatcher) continue;
        const purpose = await purposeOf(agent.id);
        out.push({ id: agent.id, name: agent.name, running: agentSystem.isAgentRunning(agent.id), ...(purpose && { purpose }) });
      }
    } catch (err) {
      // telemetry-exempt: logged; one unreadable project must not hide the others
      appLog(NS, 'warn', 'Teaching: could not read a project', { meta: { projectPath: project.path, error: errorText(err) } });
    }
  }
  return out;
}

/** What the Dispatcher can do now, from the grants it holds (its defaults and every change to them). */
export async function readDispatcherAbilities(): Promise<CapabilityGroup[]> {
  const agentId = getDispatcherAgentId();
  if (!agentId) return dispatcherCapabilities([]);
  return dispatcherCapabilities(await effectiveAgentGrants(getDispatcherPath(), agentId));
}

/** What the Dispatcher's chat shows before its first message. */
export async function readDispatcherTeaching(): Promise<DispatcherTeaching> {
  return { agents: await readTeachingAgents() };
}
