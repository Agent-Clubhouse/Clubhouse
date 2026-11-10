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
import { effectiveAgentGrants, readAgentGrants } from '../agent-grants-service';
import { dispatcherToolActions } from '../clubhouse-mcp/tool-registry';
import { appLog } from '../log-service';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { dispatcherCapabilities, turnedOffCapabilities, type CapabilityGroup, type DispatcherTeaching, type TeachingAgent } from '../../../shared/dispatcher-teaching';
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

/**
 * What the Dispatcher can do now: the grants it holds (its defaults and every
 * change to them) that a registered tool lets it use (#3238). A grant with no
 * tool isn't offered, whatever its mode. Last, what has a tool but is turned
 * off, so it can tell that apart from what Clubhouse can't do at all.
 */
export async function readDispatcherAbilities(): Promise<CapabilityGroup[]> {
  const agentId = getDispatcherAgentId();
  if (!agentId) return dispatcherCapabilities([]);
  const callable = dispatcherToolActions();
  const grants = (await effectiveAgentGrants(getDispatcherPath(), agentId)).filter((g) => callable.has(g.action));
  const groups = dispatcherCapabilities(grants);
  const { rows } = await readAgentGrants(getDispatcherPath(), agentId);
  const off = turnedOffCapabilities(rows.filter((r) => callable.has(r.action)), grants);
  return off ? [...groups, off] : groups;
}

/** What the Dispatcher's chat shows before its first message. */
export async function readDispatcherTeaching(): Promise<DispatcherTeaching> {
  return { agents: await readTeachingAgents() };
}
