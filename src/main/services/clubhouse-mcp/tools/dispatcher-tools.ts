/**
 * Dispatcher tools (#2536), in the `dispatcher` tool group: listed and
 * callable only by the running Dispatcher.
 *
 * - list_orchestrators: every orchestrator that opted in with "Connect to
 *   Dispatcher" (#2534), across every registered project, with its status,
 *   whether it is connected now, its helpers and its branch.
 *
 * list_projects comes from helper-tools, whose gate also opens for the
 * Dispatcher. These tools only read state: orchestrator to Dispatcher
 * traffic is explicit (send_message), nothing is pushed or forwarded.
 */

import { registerGlobalTool } from '../tool-registry';
import { getAgentConnection } from '../bridge-server';
import type { McpToolResult } from '../types';
import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { getGitInfo } from '../../git-service';
import { listHelpersEverywhere } from '../../helper-index';
import { getOrchestrationPolicy } from '../../orchestration-policy';
import * as projectStore from '../../project-store';
import { onDispatcherChanged } from '../../dispatcher/dispatcher-service';
import { appLog } from '../../log-service';
import { refreshDispatcherGate } from '../dispatcher-gate';
import { helperStatus, nameOfProject, projectName } from './helper-tools';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import type { DurableAgentConfig, Project } from '../../../../shared/types';

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether the agent's policy has "Connect to Dispatcher" on. Read without
 * relying on the field's type, so a policy without it (#2534 not there yet)
 * reads as off.
 */
function connectsToDispatcher(policy: object): boolean {
  return (policy as { connectToDispatcher?: unknown }).connectToDispatcher === true;
}

/** The orchestrators in one project that opted in. */
async function optedInOrchestrators(project: Project): Promise<DurableAgentConfig[]> {
  const agents = await agentConfig.listDurable(project.path);
  const result: DurableAgentConfig[] = [];
  for (const agent of agents) {
    if (isDisposedAgent(agent)) continue;
    const policy = await getOrchestrationPolicy(project.path, agent.id);
    if (policy?.orchestrate && connectsToDispatcher(policy)) result.push(agent);
  }
  return result;
}

async function currentBranch(agent: DurableAgentConfig, projectPath: string): Promise<string | null> {
  try {
    const git = await getGitInfo(agent.worktreePath || projectPath);
    return git.hasGit ? git.branch || agent.branch || null : null;
  } catch {
    // telemetry-exempt: the orchestrator is listed without a branch
    return agent.branch ?? null;
  }
}

async function describeOrchestrator(
  project: Project,
  agent: DurableAgentConfig,
  projects: readonly Project[],
): Promise<Record<string, unknown>> {
  const [helpers, branch] = await Promise.all([
    listHelpersEverywhere(project.path, agent.id),
    currentBranch(agent, project.path),
  ]);
  const helperRows = await Promise.all(helpers.map(async ({ projectPath, config }) => ({
    id: config.id,
    name: config.name,
    project: await nameOfProject(projects, projectPath),
    status: helperStatus(config).status,
  })));
  return {
    id: agent.id,
    name: agent.name,
    project: { name: projectName(project), path: project.path },
    status: helperStatus(agent).status,
    // Running and connected to the MCP bridge: it can be messaged now.
    connected: !!agentRegistry.get(agent.id) && !!getAgentConnection(agent.id),
    branch,
    helpers: { count: helperRows.length, helpers: helperRows },
  };
}

async function listOrchestrators(): Promise<McpToolResult> {
  const projects = await projectStore.list();
  const orchestrators: Record<string, unknown>[] = [];
  for (const project of projects) {
    let agents: DurableAgentConfig[];
    try {
      agents = await optedInOrchestrators(project);
    } catch (err) {
      // telemetry-exempt: logged; one unreadable project must not hide the others
      appLog('core:mcp', 'warn', 'list_orchestrators: could not read a project', {
        meta: { projectPath: project.path, error: errorText(err) },
      });
      continue;
    }
    for (const agent of agents) orchestrators.push(await describeOrchestrator(project, agent, projects));
  }
  return jsonResult({ orchestrators });
}

let unwatchDispatcher: (() => void) | null = null;

export function registerDispatcherTools(): void {
  registerGlobalTool(
    'list_orchestrators',
    {
      description:
        'List the orchestrators that are connected to you (their "Connect to Dispatcher" setting is on), ' +
        'in every Clubhouse project: id, name, project, status, whether it is connected now (running and ' +
        'reachable with send_message), its current branch, and its helpers with each one\'s project and status.',
      inputSchema: { type: 'object', properties: {} },
    },
    async (agentId) => {
      try {
        return await listOrchestrators();
      } catch (err) {
        // telemetry-exempt: the error reaches the Dispatcher as the tool result
        appLog('core:mcp', 'warn', 'list_orchestrators failed', { meta: { agentId, error: errorText(err) } });
        return { content: [{ type: 'text', text: errorText(err) }], isError: true };
      }
    },
    { group: 'dispatcher' },
  );
  // Turning the Dispatcher on or off adds or removes these tools.
  unwatchDispatcher?.();
  unwatchDispatcher = onDispatcherChanged(() => refreshDispatcherGate());
}
