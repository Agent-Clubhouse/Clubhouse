/**
 * Helper requests for a paired phone (#159): the helper starts (#2234) and
 * disposes (#2229) that orchestrators asked the user to decide, listed in the
 * Annex snapshot as `helperRequests`, and answered with `helper.approve` and
 * `helper.decline`. The paired phone has the desktop's full say here, under
 * the desktop's rules:
 *
 * - a start runs approveHelperStart / declineHelperStart, as Needs you does;
 * - a dispose runs the dispose confirmation's path (disposeHelperForUser):
 *   a check that couldn't run blocks it, work at risk needs `force` ("Dispose
 *   anyway"), and more at risk than the phone was shown disposes nothing.
 *   When the checks change the request gets a new id, so a phone answering
 *   what it saw before is refused (helper_request_not_found) and resnapshots.
 *
 * Either way the orchestrator is told, once, as from the desktop.
 */

import * as path from 'path';
import { describeHelperDisposeRequest, describeHelperStart } from '../../shared/helper-request-copy';
import type { MobileCommand, MobileHelperRequest } from '../../shared/mobile-control';
import type { DurableAgentConfig, HelperDisposeChecks } from '../../shared/types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { MobileControlError } from './mobile-control';
import { listStartRequests, peekStartRequest } from './helper-start-requests';
import { findDisposeRequest, listDisposeRequests, updateDisposeRequestChecks } from './helper-dispose-requests';
import { disposeHelperForUser, reportDisposeDecision, workAtRisk } from './helper-dispose-decisions';
import { approveHelperStart, declineHelperStart } from './clubhouse-mcp/tools/helper-tools';
import * as agentConfig from './agent-config';

/** What the desktop calls an orchestrator it can't name (app-event-bridge). */
const UNNAMED_ORCHESTRATOR = 'An orchestrator';

export interface HelperRequestProject { id: string; path: string; name?: string; displayName?: string }

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function projectFor(projects: readonly HelperRequestProject[], projectPath: string): HelperRequestProject | undefined {
  return projects.find((p) => samePath(p.path, projectPath));
}

/** The name of the project a held start would create its helper in, when that is another project (#2515). */
function startProjectName(projects: readonly HelperRequestProject[], target: string | undefined): string | undefined {
  if (!target) return undefined;
  const project = projectFor(projects, target);
  return project?.displayName || project?.name || path.basename(target);
}

function disposeFacts(checks: HelperDisposeChecks, forceRequested: boolean): NonNullable<MobileHelperRequest['dispose']> {
  const canDispose = !checks.error;
  return {
    uncommittedFiles: checks.dirty,
    unpushedCommits: checks.unpushed,
    unmergedCommits: checks.unmerged,
    checkError: checks.error ?? null,
    forceRequested,
    workAtRisk: canDispose && workAtRisk(checks),
    canDispose,
  };
}

/**
 * Every waiting request in a registered project, oldest first. `agents` is
 * each project's durable agents by project id, to name the orchestrator and
 * to leave out a dispose whose helper is gone or already disposed.
 */
export function buildMobileHelperRequests(
  projects: readonly HelperRequestProject[],
  agents: Readonly<Record<string, readonly DurableAgentConfig[]>>,
): MobileHelperRequest[] {
  const out: MobileHelperRequest[] = [];
  for (const r of listStartRequests()) {
    const project = projectFor(projects, r.projectPath);
    if (!project) continue;
    const orchestrator = agents[project.id]?.find((a) => a.id === r.orchestratorId);
    out.push({
      requestId: r.requestId,
      kind: 'start',
      projectId: project.id,
      requester: { agentId: r.orchestratorId, name: orchestrator?.name ?? r.orchestratorName },
      helper: { agentId: null, name: r.args.name },
      requestedAt: r.createdAt,
      expiresAt: r.expiresAt,
      summary: describeHelperStart(r.args.name, startProjectName(projects, r.args.project)),
      start: {
        task: r.args.task,
        persona: r.args.persona ?? null,
        model: r.args.model ?? null,
        access: r.args.access ?? null,
        branchFrom: r.args.branchFrom ?? null,
      },
    });
  }
  for (const { requestId, request, createdAt } of listDisposeRequests()) {
    const project = projectFor(projects, request.projectPath);
    if (!project) continue;
    const list = agents[project.id] ?? [];
    const helper = list.find((a) => a.id === request.helperId);
    if (!helper || isDisposedAgent(helper)) continue;
    // The request records the helper's project, so the dispose runs there; its orchestrator may be in another one (#2513).
    const parentProject = helper.parentProjectPath ? projectFor(projects, helper.parentProjectPath) : project;
    const parentList = parentProject ? agents[parentProject.id] ?? [] : [];
    const requesterName = parentList.find((a) => a.id === request.orchestratorId)?.name ?? UNNAMED_ORCHESTRATOR;
    out.push({
      requestId,
      kind: 'dispose',
      projectId: project.id,
      requester: { agentId: request.orchestratorId, name: requesterName },
      helper: { agentId: request.helperId, name: helper.name },
      requestedAt: createdAt,
      expiresAt: null,
      summary: describeHelperDisposeRequest(requesterName, request),
      dispose: disposeFacts(request.checks, request.forceRequested),
    });
  }
  return out.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
}

type HelperCommand = Extract<MobileCommand, { type: 'helper.approve' | 'helper.decline' }>;

export interface HelperCommandDeps {
  /** Throws once the phone's authorization changed; called before each side effect. */
  assertAuthorized: () => void;
  /** Ask the desktop windows to reload a project's agents, so a disposed helper leaves the rail. */
  reloadProject: (projectPath: string) => void;
}

export type HelperCommandResult =
  | { requestId: string; kind: 'start'; approved: true; helperId: string | null }
  | { requestId: string; kind: 'dispose'; approved: true; stopped: boolean }
  | { requestId: string; kind: 'start' | 'dispose'; declined: true };

/** Run `helper.approve` or `helper.decline`. Errors are MobileControlErrors for the receipt. */
export async function runHelperCommand(command: HelperCommand, deps: HelperCommandDeps): Promise<HelperCommandResult> {
  const { requestId } = command;
  const start = listStartRequests().find((r) => r.requestId === requestId);
  if (start) {
    deps.assertAuthorized();
    if (command.type === 'helper.decline') {
      const result = await declineHelperStart(start.projectPath, requestId);
      if (!result.ok) throw new MobileControlError('helper_request_not_found', 404);
      return { requestId, kind: 'start', declined: true };
    }
    const result = await approveHelperStart(start.projectPath, requestId);
    if (!result.ok) {
      // Still waiting means a fixable refusal (wake the orchestrator); gone means it was used up or answered.
      const waiting = peekStartRequest(start.projectPath, requestId);
      throw new MobileControlError(waiting ? 'helper_start_blocked' : 'helper_start_refused', 409, waiting ? 'rejected' : 'failed', result.message);
    }
    return { requestId, kind: 'start', approved: true, helperId: result.helperId ?? null };
  }

  const pending = findDisposeRequest(requestId);
  if (!pending) throw new MobileControlError('helper_request_not_found', 404);
  const { projectPath, helperId, orchestratorId } = pending.request;
  const helper = await agentConfig.getDurableConfig(projectPath, helperId);
  // The request is answerable only while its orchestrator is still the helper's parent.
  if (!helper || isDisposedAgent(helper) || helper.parentAgentId !== orchestratorId) throw new MobileControlError('helper_request_not_found', 404);
  deps.assertAuthorized();

  if (command.type === 'helper.decline') {
    const reported = await reportDisposeDecision(projectPath, helperId, 'declined');
    if (!reported.ok) throw new MobileControlError('helper_request_not_found', 404);
    return { requestId, kind: 'dispose', declined: true };
  }

  const seen = pending.request.checks;
  if (seen.error) throw new MobileControlError('helper_check_failed', 409, 'rejected', `${helper.name} can’t be disposed because it couldn’t be checked (${seen.error}). Check again on the desktop, or decline.`);
  if (workAtRisk(seen) && command.force !== true) throw new MobileControlError('helper_work_at_risk', 409, 'rejected', `${helper.name} has work that disposing would lose. Dispose anyway to delete it.`);

  const result = await disposeHelperForUser(projectPath, helperId, { force: command.force === true, seen });
  if (!result.ok) {
    // Show the phone what is at risk now; the request gets a new id to confirm against.
    if (result.checks) updateDisposeRequestChecks(requestId, result.checks);
    const stopped = result.stopped ? ` ${helper.name} is stopped.` : '';
    const message = result.message.replace(/\.$/, '');
    if (result.changed) throw new MobileControlError('helper_work_changed', 409, 'rejected', `${message}. Review what would be lost and confirm again.${stopped}`);
    if (result.checks?.error) throw new MobileControlError('helper_check_failed', 409, 'rejected', `${helper.name} wasn’t disposed because it couldn’t be checked.${stopped}`);
    if (result.checks && workAtRisk(result.checks) && command.force !== true) throw new MobileControlError('helper_work_at_risk', 409, 'rejected', `${message}.${stopped}`);
    throw new MobileControlError('helper_dispose_failed', 409, 'failed', `${message}.${stopped}`);
  }
  deps.reloadProject(projectPath);
  await reportDisposeDecision(projectPath, helperId, 'disposed');
  return { requestId, kind: 'dispose', approved: true, stopped: result.stopped === true };
}
