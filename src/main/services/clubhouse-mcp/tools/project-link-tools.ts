import { AsyncLocalStorage } from 'node:async_hooks';
import type { GrantCallTarget } from '../../../../shared/agent-grants';
import {
  parseNetworkProjectRef, parseProjectLinksOp, sidebarProjectId,
  type ProjectLinksOp,
} from '../../../../shared/project-links';
import { getSatellites } from '../../annex-client';
import { getIdentity } from '../../annex-identity';
import { controlledFromHere, listPeers, peerNeedsPairing } from '../../annex-peers';
import { callApprovalVersion } from '../../grant-requests';
import { appLog } from '../../log-service';
import { changeProjectLinks, projectLinksStore } from '../../project-links-store';
import { repoKeysFor } from '../../project-repo-keys';
import * as projectStore from '../../project-store';
import { setProjectLinkTargetResolver, type ArgTargets } from '../arg-targets';
import { describeCallsForAsk } from '../ask-first';
import { isDispatcherAgent } from '../dispatcher-gate';
import { checkToolGrant, decideGrant } from '../grant-check';
import { callGrantIsApproved, grantApprovalContext, registerGlobalTool } from '../tool-registry';
import type { ToolGrantDeclaration } from '../tool-grants';
import type { McpToolResult } from '../types';

type LinkTool = 'link_projects' | 'unlink_project' | 'keep_projects_separate';
interface VisibleProject {
  id: string;
  name: string;
  machineId: string;
  machineName: string;
  local: boolean;
  path?: string;
  repoKey?: string;
}
interface LinkTarget extends GrantCallTarget {
  /** Included in the registry's approval context, even for pathless remote targets. */
  projectLinkId: string;
}
const pairKey = (a: string, b: string) => [a, b].sort().join('\n');
const PAIR_GRANT: ToolGrantDeclaration = { actions: ['project.link'], target: 'project_arg', from: { args: ['a', 'b'] } };
const UNLINK_GRANT: ToolGrantDeclaration = { actions: ['project.link'], target: 'project_arg', from: { args: ['project'] } };
const calls = new AsyncLocalStorage<{ agentId: string; tool: LinkTool; args: Record<string, unknown>; approvalVersion: number }>();
let projectRevision = 0;
let watchingProjects = false;
const projectNames = new Map<string, string>();

function remoteProjects(): VisibleProject[] {
  const peers = listPeers().filter((p) => controlledFromHere(p) && !p.networkPending && !peerNeedsPairing(p));
  return getSatellites().flatMap((satellite) => {
    const machine = satellite.fingerprint.toLowerCase();
    if (satellite.needsPairing || !peers.some((p) => p.fingerprint.toLowerCase() === machine)) return [];
    return (satellite.snapshot?.projects ?? []).flatMap((raw): VisibleProject[] => {
      if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string'
        || !('name' in raw) || typeof raw.name !== 'string') return [];
      const ref = parseNetworkProjectRef({ machine, projectId: raw.id });
      return [{
        id: sidebarProjectId(ref, ''), name: 'displayName' in raw && typeof raw.displayName === 'string' ? raw.displayName : raw.name,
        machineId: machine, machineName: satellite.alias, local: false,
        ...('repoKey' in raw && typeof raw.repoKey === 'string' && { repoKey: raw.repoKey }),
      }];
    });
  });
}

async function visibleProjects(): Promise<VisibleProject[]> {
  const identity = getIdentity();
  if (!identity) throw new Error('Annex identity is not ready for project links.');
  const projects = await projectStore.list();
  const visible = [
    ...projects.map((p) => ({
      id: p.id, name: p.displayName || p.name, machineId: identity.fingerprint.toLowerCase(),
      machineName: 'This computer', local: true, path: p.path,
    })),
    ...remoteProjects(),
  ];
  projectNames.clear();
  for (const project of visible) projectNames.set(project.id, `${project.name} (${project.machineName})`);
  return visible;
}

function linkOperation(tool: LinkTool, args: Record<string, unknown>): ProjectLinksOp {
  const fields = tool === 'unlink_project' ? ['project'] : ['a', 'b'];
  if (Object.keys(args).some((key) => !fields.includes(key))) throw new Error('Give only the project ids this tool accepts.');
  const op = parseProjectLinksOp(tool === 'unlink_project'
    ? { type: 'unlink', a: args.project }
    : { type: tool === 'link_projects' ? 'link' : 'keepSeparate', a: args.a, b: args.b });
  if ('b' in op && op.a === op.b) throw new Error('Choose two different projects.');
  return op;
}

function affectedIds(op: ProjectLinksOp): string[] {
  const view = projectLinksStore().view();
  const groupOf = (id: string) => view.links.find((group) => group.includes(id)) ?? [id];
  return [...new Set('b' in op ? [...groupOf(op.a), ...groupOf(op.b)] : groupOf(op.a))].sort();
}

function targetsFor(ids: readonly string[], projects: readonly VisibleProject[]): LinkTarget[] {
  return ids.map((id) => {
    const project = projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project "${id}" is not visible on this computer or a currently paired computer. Use list_project_links for valid ids.`);
    return { kind: 'project', projectLinkId: id, ...(project.local && { projectPath: project.path }) };
  });
}

async function resolveLinkTargets(args: Record<string, unknown>, from: readonly string[]): Promise<GrantCallTarget[]> {
  if (!from.some((key) => args[key] !== undefined)) return [{ kind: 'project' }];
  const tool = from.includes('project') ? 'unlink_project' : 'link_projects';
  // Both pair tools require permission on the whole group: a separation may split it.
  const ids = affectedIds(linkOperation(tool, args));
  return targetsFor(ids, await visibleProjects());
}

/**
 * Same consumed-call approval check as handoff-permissions, re-evaluated by
 * the store at the queued write and atomic save boundaries. No UI impersonation.
 */
export async function projectLinkMcpAuthorization(actorId: string, raw: unknown): Promise<() => boolean> {
  const call = calls.getStore();
  if (!call || call.agentId !== actorId || !isDispatcherAgent(actorId)) throw new Error('Only the Dispatcher can link projects through MCP.');
  const op = linkOperation(call.tool, call.args);
  if (JSON.stringify(parseProjectLinksOp(raw)) !== JSON.stringify(op)) throw new Error('The project link call changed.');
  const revision = projectRevision;
  const machine = getIdentity()?.fingerprint;
  const projects = await visibleProjects();
  const ids = affectedIds(op);
  const grant = call.tool === 'unlink_project' ? UNLINK_GRANT : PAIR_GRANT;
  const targetSnapshot = targetsFor(ids, projects);
  const allowed = (): boolean => {
    if (!isDispatcherAgent(actorId) || projectRevision !== revision || getIdentity()?.fingerprint !== machine
      || callApprovalVersion(actorId) !== call.approvalVersion) return false;
    const liveProjects = [...projects.filter((p) => p.local), ...remoteProjects()];
    const targets = targetsFor(affectedIds(op), liveProjects);
    if (JSON.stringify(targets) !== JSON.stringify(targetSnapshot)) return false;
    const resolved: ArgTargets = new Map([[grant, targets]]);
    // A refusal wins even when an earlier exact call was approved.
    if (targets.some((target) => decideGrant(actorId, 'project.link', target).outcome === 'refuse')) return false;
    const check = checkToolGrant(actorId, grant, call.args, undefined, resolved);
    return callGrantIsApproved(actorId, call.tool, call.args, check,
      grantApprovalContext(actorId, call.tool, call.args, grant, resolved));
  };
  if (!allowed()) throw new Error('The project.link permission or this call\'s approval changed.');
  return allowed;
}

function json(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) };
}

async function listLinks(): Promise<McpToolResult> {
  const projects = await visibleProjects();
  const keys = await repoKeysFor(projects.flatMap((p) => p.local && p.path ? [{ id: p.id, path: p.path }] : []));
  const view = projectLinksStore().view();
  const kept = new Set(view.keptSeparate);
  const suggestions = projects.filter((p) => p.local && keys[p.id]).flatMap((local) => projects
    .filter((remote) => !remote.local && remote.repoKey === keys[local.id]
      && !kept.has(pairKey(local.id, remote.id)) && !view.links.some((g) => g.includes(local.id) && g.includes(remote.id)))
    .map((remote) => ({ a: local.id, b: remote.id, repoKey: keys[local.id] })));
  return json({ ...view, projects: projects.map(({ path: _path, ...p }) => ({ ...p, ...(p.local && keys[p.id] && { repoKey: keys[p.id] }) })), suggestions });
}

export function registerProjectLinkTools(): void {
  if (!watchingProjects) {
    watchingProjects = true;
    projectStore.onProjectsChanged(() => { projectRevision++; });
  }
  setProjectLinkTargetResolver(resolveLinkTargets);
  registerGlobalTool('list_project_links', {
    description: 'List current project links, kept-separate pairs, visible project ids and same-repository link suggestions across paired computers. Suggestions exclude linked and kept-separate pairs. Links are metadata only; they never move files, credentials or agents. Unavailable ids in saved links cannot be changed until visible again.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, async () => {
    try { return await listLinks(); }
    catch (error) {
      // telemetry-exempt: logged; the error reaches the caller as the tool result
      const message = error instanceof Error ? error.message : String(error);
      appLog('core:mcp', 'warn', 'list_project_links failed', { meta: { error: message } });
      return json({ status: 'failed', message }, true);
    }
  }, { group: 'dispatcher', grant: { actions: ['project.read'], target: 'all_projects' } });

  const descriptions: Record<LinkTool, string> = {
    link_projects: 'Link two visible projects, or add one to an existing linked group (merges both whole groups). Use ids from list_project_links. This also undoes Keep separate by explicitly linking again, not by restoring an unlinked suggestion.',
    unlink_project: 'Remove one visible project from its linked group and keep it separate from its former members, as the UI does. Use link_projects to link it again.',
    keep_projects_separate: 'Keep two visible projects separate and stop suggesting this pair. If linked, this separates them. Undo with link_projects, which explicitly links them again.',
  };
  for (const tool of Object.keys(descriptions) as LinkTool[]) {
    describeCallsForAsk(tool, (args) => {
      const op = linkOperation(tool, args);
      const ids = affectedIds(op);
      return `${descriptions[tool]} Affected projects: ${ids.map((id) => projectNames.get(id) ?? id).join(', ')}. Only synced link metadata changes; no files, credentials or agents move.`;
    });
    const properties = tool === 'unlink_project'
      ? { project: { type: 'string', description: 'Project id from list_project_links.' } }
      : { a: { type: 'string', description: 'First project id from list_project_links.' }, b: { type: 'string', description: 'Second project id, or any member of the destination group.' } };
    registerGlobalTool(tool, {
      description: `${descriptions[tool]} Requires project.link (Ask first by default). Only synced link metadata changes; no files, credentials or agents move. Returns revision, links and keptSeparate.`,
      inputSchema: { type: 'object', properties, required: tool === 'unlink_project' ? ['project'] : ['a', 'b'], additionalProperties: false },
    }, async (agentId, args) => {
      const approvalVersion = callApprovalVersion(agentId);
      try {
        const op = linkOperation(tool, args);
        targetsFor(affectedIds(op), await visibleProjects());
        return await calls.run({ agentId, tool, args, approvalVersion }, async () => json(await changeProjectLinks(op)));
      } catch (error) {
        // telemetry-exempt: logged; the refusal or failure reaches the caller as the tool result
        const message = error instanceof Error ? error.message : String(error);
        appLog('core:mcp', 'warn', `${tool} failed or was refused`, { meta: { agentId, error: message } });
        return json({ status: 'refused', message }, true);
      }
    }, { group: 'dispatcher', grant: tool === 'unlink_project' ? UNLINK_GRANT : PAIR_GRANT });
  }
}
