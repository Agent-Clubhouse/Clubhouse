/**
 * What a proposed MCP or Clubhouse mode change would turn off, read before it is
 * saved so the turn-off dialog can say so (#2589). Changes nothing: it resolves
 * the proposal beside the saved settings and counts the difference.
 *
 * MCP going off stops no agent. So the counts are of what loses Clubhouse tools,
 * by the same rule as the call gate (clubhouse-mcp/mcp-call-gate), and the `keeps`
 * lists are what doesn't: a project with its own override or Clubhouse mode, and an
 * agent with its own override. A helper is read with its raw override: one that
 * loses them can still report to its parent.
 */

import { isDisposedAgent } from '../../shared/agent-helpers';
import { savedOrchestrate } from '../../shared/orchestration-policy';
import type { DurableAgentConfig } from '../../shared/types';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { getSettings as getClubhouseModeSettings } from './clubhouse-mode-settings';
import { isDispatcherPath } from './dispatcher/dispatcher-paths';
import { dispatcherEnablement } from './dispatcher/dispatcher-settings';
import { getDispatcherState } from './dispatcher/dispatcher-service';
import { listHelpersEverywhere } from './helper-index';
import { appLog } from './log-service';
import { getSettings as getMcpSettings, isMcpEnabled, isMcpOnAtAppLevel, resolveMcpWithProposal, type McpProposal } from './mcp-settings';
import { resolveOrchestrationPolicies } from './orchestration-policy';
import * as projectStore from './project-store';
import type { McpOffImpact, McpKeptBy } from '../../shared/mcp-off-impact';

/** Why a project still has MCP under the proposal: its MCP override wins over Clubhouse mode. */
function projectKeptBy(proposal: McpProposal, projectPath: string): McpKeptBy {
  const overrides = { ...getMcpSettings(), ...proposal.mcp }.projectOverrides;
  return overrides?.[projectPath] === true ? 'project_setting' : 'clubhouse_mode';
}

/** One project's share of the impact, added to `impact`. */
async function addProject(
  impact: McpOffImpact,
  proposal: McpProposal,
  project: { path: string; name: string },
  agents: DurableAgentConfig[],
): Promise<void> {
  const { path: projectPath, name } = project;
  const live = agents.filter((a) => !isDisposedAgent(a));
  const projectBefore = isMcpEnabled(projectPath);
  const projectAfter = resolveMcpWithProposal(proposal, projectPath);
  if (projectBefore && !projectAfter) {
    impact.turnsOff = true;
    impact.projectsLosing.push(name);
  }
  // With MCP off at app level, a project still on has a setting of its own.
  if (projectAfter && impact.appLoses) impact.keeps.projects.push({ name, via: projectKeptBy(proposal, projectPath) });

  const losing: DurableAgentConfig[] = [];
  for (const agent of live) {
    const before = isMcpEnabled(projectPath, agent.mcpOverride);
    const after = resolveMcpWithProposal(proposal, projectPath, agent.mcpOverride);
    if (before && !after) {
      if (agent.parentAgentId) impact.helpersReportOnly++;
      else losing.push(agent);
      continue;
    }
    if (!after) continue;
    if (impact.appLoses || !projectAfter) impact.agentsKeeping++;
    // Only agents the change would have taken with it, so a project that keeps MCP lists nobody.
    if (!projectAfter) impact.keeps.agents.push({ name: agent.name, project: name });
  }
  if (impact.helpersReportOnly > 0) impact.turnsOff = true;
  if (losing.length === 0) return;
  impact.turnsOff = true;
  impact.agentsLosing += losing.length;

  const policies = await resolveOrchestrationPolicies(projectPath, losing);
  for (const agent of losing) {
    const policy = policies.get(agent.id);
    if (!policy) continue;
    if (savedOrchestrate(policy)) impact.orchestratorsLosing++;
    if (policy.connectToDispatcher) impact.connectedLosing++;
    if (!agentRegistry.get(agent.id)) continue;
    impact.runningLosing++;
    if ((await listHelpersEverywhere(projectPath, agent.id)).length > 0) impact.runningOrchestratorsWithHelpers++;
  }
}

export async function readMcpOffImpact(proposal: McpProposal): Promise<McpOffImpact> {
  const appBefore = isMcpOnAtAppLevel();
  const appAfter = resolveMcpWithProposal(proposal);
  const appLoses = appBefore && !appAfter;
  const clubhouseAfter = { ...getClubhouseModeSettings(), ...proposal.clubhouseMode }.enabled;
  const dispatcher = getDispatcherState();
  // Whether it is on now and this change is what turns it off.
  const dispatcherGoesOff = appLoses && dispatcherEnablement().enabled;
  const impact: McpOffImpact = {
    turnsOff: appLoses,
    appLoses,
    appKeptByClubhouseMode: !appAfter ? false : !{ ...getMcpSettings(), ...proposal.mcp }.enabled && clubhouseAfter,
    projectsLosing: [],
    agentsLosing: 0,
    agentsKeeping: 0,
    helpersReportOnly: 0,
    orchestratorsLosing: 0,
    connectedLosing: 0,
    runningLosing: 0,
    runningOrchestratorsWithHelpers: 0,
    dispatcherGoesOff,
    dispatcherRunning: dispatcher.running,
    keeps: { projects: [], agents: [] },
    unreadableProjects: [],
  };

  for (const project of await projectStore.list()) {
    if (isDispatcherPath(project.path)) continue;
    const name = project.displayName || project.name;
    try {
      await addProject(impact, proposal, { path: project.path, name }, await agentConfig.listDurable(project.path));
    } catch (err) {
      // telemetry-exempt: logged; the dialog names the project it couldn't count
      impact.unreadableProjects.push(name);
      appLog('core:mcp', 'warn', 'Could not count a project for the MCP turn-off dialog', {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return impact;
}
