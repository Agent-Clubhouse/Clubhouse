import type { DeleteAgentReviewTarget, DeleteAgentsReview, DeleteAgentsReviewItem } from '../../../../shared/delete-agents';
import { GRANT_REQUEST_DETAILS_MAX, GRANT_REQUEST_TTL_MS } from '../../../../shared/grant-requests';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import type { GrantCallTarget } from '../../../../shared/agent-grants';
import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { deleteAgent, isDeleteRefusal } from '../../agent-delete';
import { deleteReviewFingerprint } from '../../delete-review-state';
import { withDeleteReview } from '../../delete-review-guard';
import { listHelpersEverywhere } from '../../helper-index';
import * as projects from '../../project-store';
import { callApprovalVersion, callKey, consumeCallApprovalScope, recordGrantRequest, listGrantRequests, grantRequestKey } from '../../grant-requests';
import { agentNameOf } from '../ask-first';
import { resolvedAgentGrantTarget } from '../arg-targets';
import { checkToolGrant } from '../grant-check';
import { grantApprovalContext, registerGlobalTool } from '../tool-registry';
import { isDispatcherAgent, isTrackedDispatcher, isDispatcherCoordinatorId } from '../dispatcher-gate';
import type { ToolGrantDeclaration } from '../tool-grants';
import type { McpToolResult } from '../types';

// Resolution and approval belong to this operation, as for template pushes.
const GRANT: ToolGrantDeclaration = { actions: ['agent.dispose'], target: 'agent_arg' };
interface TargetSnapshot { review: DeleteAgentReviewTarget; fingerprint: string; grant: GrantCallTarget; projectId: string; excludedBranches: string[] }
interface PlanItem { review: DeleteAgentsReviewItem; target?: TargetSnapshot; helpers: TargetSnapshot[] }
interface Plan { kind: 'delete_agents'; version: number; until: number; context: string; items: PlanItem[] }

function result(value: unknown, error = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(error && { isError: true }) };
}
function text(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function targets(items: PlanItem[]) { return new Map([[GRANT, items.flatMap((row) => row.target ? [row.target.grant] : [])]]); }
function context(caller: string, args: Record<string, unknown>, items: PlanItem[]) {
  return grantApprovalContext(caller, 'delete_agents', args, GRANT, targets(items));
}

async function snapshot(caller: string, project: string, config: import('../../../../shared/types').DurableAgentConfig, excludedBranches: string[] = []): Promise<TargetSnapshot> {
  if (config.id === caller || isDispatcherAgent(config.id) || isTrackedDispatcher(config.id) || isDispatcherCoordinatorId(config.id)) throw new Error('Never yourself or the Dispatcher.');
  if (isDisposedAgent(config)) throw new Error('This agent is disposed.');
  if (config.creation?.state === 'creating') throw new Error('This agent is still being created.');
  const registered = (await projects.peekProjects()).filter((p) => p.path === project);
  if (registered.length !== 1) throw new Error('The project must remain registered exactly once.');
  const work = config.worktreePath ? await agentConfig.getWorktreeStatus(project, config.id, excludedBranches) : undefined;
  return {
    review: { project, agentId: config.id, name: config.name, worktreePath: config.worktreePath, branch: config.branch, work },
    fingerprint: await deleteReviewFingerprint(config, work),
    grant: await resolvedAgentGrantTarget(caller, config, project),
    projectId: registered[0].id, excludedBranches,
  };
}

async function prepare(caller: string, values: unknown[]): Promise<PlanItem[]> {
  const registered = await projects.peekProjects();
  const seen = new Set<string>();
  const rows: PlanItem[] = [];
  for (const [index, value] of values.entries()) {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const review: DeleteAgentsReviewItem = {
      index, requestedProject: typeof item.project === 'string' ? item.project : '', requestedAgent: typeof item.agent === 'string' ? item.agent : '',
      status: 'refused', worktree: item.worktree === 'keep' ? 'keep' : 'delete', helpers: item.helpers === 'keep' ? 'keep' : 'dispose',
      force: item.force === true, helperTargets: [],
    };
    const row: PlanItem = { review, helpers: [] };
    rows.push(row);
    try {
      if (!review.requestedProject || !review.requestedAgent) throw new Error('Each item needs a project and agent.');
      if (item.worktree !== 'delete' && item.worktree !== 'keep') throw new Error('Choose worktree delete or keep.');
      if (item.helpers !== 'dispose' && item.helpers !== 'keep') throw new Error('Choose helpers dispose or keep.');
      if (item.force !== undefined && typeof item.force !== 'boolean') throw new Error('force must be a boolean.');
      const ref = review.requestedProject;
      const exact = registered.filter((p) => p.path === ref || p.id === ref);
      const matches = exact.length ? exact : registered.filter((p) => p.name.toLowerCase() === ref.toLowerCase() || p.displayName?.toLowerCase() === ref.toLowerCase());
      if (matches.length !== 1) throw new Error('The project must resolve to exactly one registered local project.');
      const project = matches[0];
      const agents = await agentConfig.peekDurableConfigs(project.path);
      const byId = agents.filter((a) => a.id === review.requestedAgent);
      const found = byId.length ? byId : agents.filter((a) => a.name.toLowerCase() === review.requestedAgent.toLowerCase());
      if (found.length !== 1) throw new Error('The agent must resolve to exactly one agent in that project.');
      const target = await snapshot(caller, project.path, found[0]);
      review.target = target.review;
      const key = `${project.path}\0${found[0].id}`;
      if (seen.has(key)) throw new Error('This target is already in the batch.');
      seen.add(key);
      const check = checkToolGrant(caller, GRANT, {}, undefined, new Map([[GRANT, [target.grant]]]));
      if (check.ok === false && check.reason !== 'ask_first') throw new Error(check.message);
      for (const helper of await listHelpersEverywhere(project.path, found[0].id, { recursive: true })) {
        row.helpers.push(await snapshot(caller, helper.projectPath, helper.config));
      }
      review.helperTargets = row.helpers.map((helper) => helper.review);
      row.target = target;
      review.status = 'ready';
    } catch (error) {
      // telemetry-exempt: every validation refusal is included in the review and result.
      review.reason = text(error);
    }
  }
  // Overlapping cascades cannot describe independent consequences accurately.
  const roots = new Set(rows.flatMap((row) => row.target ? [`${row.target.review.project}\0${row.target.review.agentId}`] : []));
  const affected = new Set<string>();
  for (const row of rows) {
    if (!row.target) continue;
    const keys = row.helpers.map((h) => `${h.review.project}\0${h.review.agentId}`);
    if (keys.some((key) => roots.has(key) || affected.has(key))) {
      row.review.status = 'refused';
      row.review.reason = 'This helper cascade overlaps another target. Use separate batches.';
      delete row.target;
    } else keys.forEach((key) => affected.add(key));
  }
  // Commits saved only on another branch in this batch would also be lost.
  const removed = rows.flatMap((row) => row.target ? [...(row.review.worktree === 'delete' ? [row.target] : []), ...(row.review.helpers === 'dispose' ? row.helpers : [])] : []);
  for (const row of rows) {
    if (!row.target) continue;
    try {
      for (const target of [row.target, ...row.helpers]) {
        const branches = removed.filter((other) => other.review.project === target.review.project).flatMap((other) => other.review.branch ? [other.review.branch] : []);
        const config = await agentConfig.getDurableConfig(target.review.project, target.review.agentId);
        if (!config) throw new Error('This agent was removed during review.');
        Object.assign(target, await snapshot(caller, target.review.project, config, branches));
      }
      row.review.target = row.target.review;
      row.review.helperTargets = row.helpers.map((h) => h.review);
      const deleting = [...(row.review.worktree === 'delete' ? [row.target] : []), ...(row.review.helpers === 'dispose' ? row.helpers : [])];
      for (const target of deleting) {
        const work = target.review.work;
        if (work?.checkError) throw new Error(`${target.review.name} could not be checked. ${work.checkError}`);
        if (!row.review.force && work && (work.uncommittedFiles.length || work.unpushedCommits.length)) throw new Error(`${target.review.name} has uncommitted or unpushed work. Keep its files or explicitly set force for this item.`);
      }
    } catch (error) {
      // telemetry-exempt: included as a refused review row.
      row.review.status = 'refused'; row.review.reason = text(error); delete row.target;
    }
  }
  return rows;
}

async function execute(caller: string, args: Record<string, unknown>, plan: Plan): Promise<McpToolResult> {
  const receipts: Record<string, unknown>[] = [];
  for (const row of plan.items) {
    const base = { index: row.review.index, project: row.review.target?.project ?? row.review.requestedProject, agent: row.review.target?.agentId ?? row.review.requestedAgent };
    if (!row.target || row.review.status === 'refused') {
      receipts.push({ ...base, status: 'refused', reason: row.review.reason });
      continue;
    }
    let refusal: string | undefined;
    let effects = false;
    const guard = async (project: string, id: string) => {
      try {
        if (Date.now() >= plan.until) throw new Error('This batch approval expired.');
        if (!isDispatcherAgent(caller)) throw new Error('The originating Dispatcher is no longer active.');
        if (callApprovalVersion(caller) !== plan.version || context(caller, args, plan.items) !== plan.context) throw new Error('Permissions or policy changed after review. Request approval again.');
        const registry = projects.projectRegistryMutationState();
        if (registry.pending) throw new Error('The project registry is changing.');
        if (!(await projects.peekProjects()).some((p) => p.path === project)) throw new Error('The registered project was removed.');
        const pinned = [row.target!, ...row.helpers].find((target) => target.review.project === project && target.review.agentId === id);
        if (!pinned) throw new Error('This target was not in the approved review.');
        const config = await agentConfig.getDurableConfig(project, id);
        if (!config) throw new Error('This agent was removed after review.');
        const fresh = await snapshot(caller, project, config, pinned.excludedBranches);
        if (fresh.projectId !== pinned.projectId || fresh.fingerprint !== pinned.fingerprint || JSON.stringify(fresh.grant) !== JSON.stringify(pinned.grant)) throw new Error(`${pinned.review.name} or its worktree changed after review.`);
        if (id === row.target!.review.agentId && project === row.target!.review.project) {
          const currentHelpers = await listHelpersEverywhere(project, id, { recursive: true });
          if (currentHelpers.some((helper) => !row.helpers.some((original) => original.review.project === helper.projectPath && original.review.agentId === helper.config.id))) throw new Error('A helper was added after review.');
        }
        const check = checkToolGrant(caller, GRANT, args, undefined, new Map([[GRANT, [row.target!.grant]]]));
        if (check.ok === false && check.reason !== 'ask_first') throw new Error(check.message);
        const after = projects.projectRegistryMutationState();
        if (after.pending || after.generation !== registry.generation || Date.now() >= plan.until || callApprovalVersion(caller) !== plan.version || context(caller, args, plan.items) !== plan.context) throw new Error('Authorization changed while checking this target.');
      } catch (error) {
        // telemetry-exempt: retained in the individual receipt, including any earlier effects.
        refusal = text(error);
        throw error;
      }
    };
    try {
      const target = row.target.review;
      await guard(target.project, target.agentId);
      const helpers = await listHelpersEverywhere(target.project, target.agentId, { recursive: true });
      const keys = (list: { projectPath: string; config: { id: string } }[]) => list.map((h) => `${h.projectPath}\0${h.config.id}`).sort();
      const approvedKeys = row.helpers.map((h) => `${h.review.project}\0${h.review.agentId}`).sort();
      if (JSON.stringify(keys(helpers)) !== JSON.stringify(approvedKeys)) { refusal = 'The helper list changed after review.'; throw new Error(refusal); }
      for (const helper of row.helpers) await guard(helper.review.project, helper.review.agentId);
      const deleted = await withDeleteReview(guard, () => deleteAgent(target.project, target.agentId, {
        mode: row.review.worktree === 'keep' ? 'unregister' : 'force', helpers: row.review.helpers,
        checkWorktree: true, forceWorktree: row.review.force, forceHelpers: row.review.force,
      }), () => { effects = true; });
      effects ||= !!deleted.helpers?.helperIds?.length || !!deleted.stoppedQuickAgents?.length;
      receipts.push({ ...base, status: deleted.ok ? 'done' : effects ? 'failed' : refusal || isDeleteRefusal(deleted) ? 'refused' : 'failed', reason: refusal ?? deleted.message, ...(effects && { effectsStarted: true }), result: deleted });
    } catch (error) {
      // telemetry-exempt: an individual failure never silently skips the remaining targets.
      receipts.push({ ...base, status: !effects && refusal ? 'refused' : 'failed', reason: text(error), ...(effects && { effectsStarted: true }) });
    }
  }
  const status = receipts.every((row) => row.status === 'done') ? 'done'
    : receipts.some((row) => row.status === 'done') ? 'partial'
      : receipts.some((row) => row.status === 'failed') ? 'failed' : 'refused';
  return result({ status, items: receipts });
}

export function registerDeleteAgentsTool(): void {
  registerGlobalTool('delete_agents', {
    description: 'Delete several named local agents with one exact Needs you review on this computer. Each item needs project, agent, worktree (delete or keep), helpers (dispose or keep), and optional force. Invalid or changed targets are refused before side effects; later problems are failed with consequences. Force covers Git-reported work in that item, including its helpers. Ignored files and work inside untracked nested repositories are not checked and can be deleted even without force. Never yourself or the Dispatcher. Repeat identical arguments after human approval; expires after 24 hours.',
    inputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 50, items: {
      type: 'object', required: ['project', 'agent', 'worktree', 'helpers'], properties: {
        project: { type: 'string' }, agent: { type: 'string' }, worktree: { type: 'string', enum: ['delete', 'keep'] },
        helpers: { type: 'string', enum: ['dispose', 'keep'] }, force: { type: 'boolean' },
      },
    } } } },
  }, async (caller, args) => {
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 50 || JSON.stringify(args).length > GRANT_REQUEST_DETAILS_MAX) return result({ status: 'refused', reason: 'Use between 1 and 50 items with reviewable arguments.' }, true);
    const key = callKey(caller, 'delete_agents', args);
    const approval = consumeCallApprovalScope(key);
    const saved = approval?.scope.snapshot as Plan | undefined;
    if (saved?.kind === 'delete_agents' && saved.context === approval?.scope.context) return execute(caller, args, saved);
    const waiting = listGrantRequests().find((request) => grantRequestKey(request.requestId) === key);
    if (waiting) return result({ status: 'needs_approval', requestId: waiting.requestId, items: waiting.deleteReview?.items, message: 'This exact batch is already waiting in Needs you on this computer.' });
    const version = callApprovalVersion(caller);
    const items = await prepare(caller, args.items);
    const review: DeleteAgentsReview = { items: items.map((row) => row.review) };
    if (!items.some((row) => row.target)) return result({ status: 'refused', items: review.items });
    if (callApprovalVersion(caller) !== version) return result({ status: 'refused', reason: 'Permissions changed during review. Try again.', items: review.items });
    const projectPath = agentRegistry.get(caller)?.projectPath;
    if (!projectPath) return result({ status: 'refused', reason: 'The caller is no longer registered.', items: review.items });
    const plan: Plan = { kind: 'delete_agents', version, until: Date.now() + GRANT_REQUEST_TTL_MS, context: context(caller, args, items), items };
    const recorded = recordGrantRequest(key, {
      kind: 'call', agentId: caller, agentName: await agentNameOf(caller, projectPath), projectPath,
      toolName: 'delete_agents', actions: ['agent.dispose'], where: 'the exact agents in this deletion batch',
      deleteReview: review, argumentsText: JSON.stringify(args, null, 2),
    }, Date.now(), { context: plan.context, asks: [{ action: 'agent.dispose', where: 'the exact agents in this deletion batch' }], snapshot: plan });
    return recorded.ok ? result({ status: 'needs_approval', requestId: recorded.request.requestId, items: review.items,
      message: 'Waiting in Needs you on this computer. The person approves the ready targets together. Repeat this exact call after approval.' })
      : result({ status: 'refused', reason: 'Wait for an answer to your pending requests.', items: review.items });
  }, { group: 'dispatcher', grant: GRANT });
}
