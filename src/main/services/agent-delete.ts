/**
 * Deleting a durable agent with its helpers (#3182). The delete dialog and the
 * delete_agent MCP tool both come here, so an orchestrator's helpers are
 * settled the same way whichever started it:
 *
 * 1. With live helpers (in any project, helpers of helpers too) the caller
 *    must say what happens to them. Without a choice nothing changes and the
 *    result lists them.
 * 2. A caller with no dialog (`checkWorktree`) has the agent's own worktree
 *    checked before anything changes: unsaved work refuses a delete that
 *    removes it unless `forceWorktree`, and a check that couldn't run always
 *    refuses one.
 * 3. Helpers are disposed (stopped first, each in its own project, with the
 *    dispose checks; work at risk stops it unless `forceHelpers`) or kept.
 *    Its orchestration gate is closed meanwhile, so it can't start another;
 *    one whose start was already under way is settled too. If any helper is
 *    left, the agent is not deleted and the gate opens again.
 * 4. Quick agents running in its worktree are stopped, as the dialog stops
 *    its quick agents, so none is left working in a folder that is going.
 * 5. The agent is stopped. With `checkWorktree`, its worktree is checked
 *    again now nothing runs in it: work written since the first check
 *    refuses the delete (unless `forceWorktree`), with the helpers settled
 *    and the agent stopped but nothing lost.
 * 6. It is deleted in the chosen mode.
 *
 * It runs under the agent's lock, so a dispose_helper or orchestration change
 * for the same agent can't run in the middle. Nothing here asks the user.
 * Each call is one `clubhouse.agent.delete` flow: a refusal is `skipped`.
 */

import * as path from 'path';
import { assertDeleteReview, hasDeleteReview } from './delete-review-guard';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { isAgentRunning, killAgent } from './agent-system';
import { listHelpersEverywhere } from './helper-index';
import { settleHelpers, withAgentLock } from './orchestration-policy';
import * as dispatcher from './dispatcher/dispatcher-service';
import { appLog } from './log-service';
import { isCrossProjectEnabled, isOrchestrationEnabled, orchestrationControl, setOrchestrationEnabled } from './clubhouse-mcp/orchestration-gate';
import { tel, withErrorType } from '../telemetry/facade';
import { ATTR } from '../../shared/telemetry/attributes';
import type { AgentDeleteMode, AgentDeleteResult, DeleteResult, HelperCascadeResult, HelperDeleteChoice, WorktreeStatus } from '../../shared/types';

export type { AgentDeleteMode, AgentDeleteResult };

export const AGENT_DELETE_MODES: readonly AgentDeleteMode[] = ['commit-push', 'cleanup-branch', 'save-patch', 'force', 'unregister'];

export function isAgentDeleteMode(value: unknown): value is AgentDeleteMode {
  return (AGENT_DELETE_MODES as readonly unknown[]).includes(value);
}

export interface AgentDeleteRequest {
  mode: AgentDeleteMode;
  /** Where save-patch writes the patch. Required for that mode. */
  savePath?: string;
  /** What happens to the agent's helpers. Required when it has any. */
  helpers?: HelperDeleteChoice;
  /** Dispose helpers whose work is at risk anyway. Never overrides a check that couldn't run. */
  forceHelpers?: boolean;
  /** Check the agent's own worktree before anything changes (callers with no dialog). */
  checkWorktree?: boolean;
  /** With `checkWorktree`: delete a worktree with unsaved work anyway. A failed check still refuses. */
  forceWorktree?: boolean;
}

/** Whether `child` is `root` or a folder inside it. */
function isWithin(root: string, child: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(root), norm(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Running quick agents working in the agent's worktree: the quick agents
 * started from it (they run in its worktree), and any other quick run
 * pointed inside it. Main knows no parent link for a quick agent, only where
 * it runs.
 */
function runningQuickAgentsIn(worktreePath: string | undefined): Array<{ id: string; projectPath: string }> {
  if (!worktreePath) return [];
  const out: Array<{ id: string; projectPath: string }> = [];
  for (const [id, registration] of agentRegistry.getAllRegistrations()) {
    if (!id.startsWith('quick_') || !registration.cwd || !isAgentRunning(id)) continue;
    if (isWithin(worktreePath, registration.cwd)) out.push({ id, projectPath: registration.projectPath });
  }
  return out;
}

const MODE_ATTR: Record<AgentDeleteMode, Parameters<typeof ATTR.deleteMode>[0]> = {
  'commit-push': 'commit_push',
  'cleanup-branch': 'cleanup_branch',
  'save-patch': 'save_patch',
  force: 'force',
  unregister: 'unregister',
};

/**
 * A delete that was refused rather than failed: nothing was lost and the
 * caller can choose again (helpers to choose for, work at risk, a worktree
 * with unsaved work). A helper that failed part way is a failure.
 */
export function isDeleteRefusal(result: AgentDeleteResult): boolean {
  if (result.ok || result.stopFailed) return false;
  if (result.needsHelperChoice || result.worktree) return true;
  return !!result.helpers && !result.helpers.ok && !result.helpers.failed?.length;
}

/** Modes that remove the worktree with whatever is in it. */
function losesWorktree(mode: AgentDeleteMode): boolean {
  return mode === 'force';
}

function worktreeHasWork(status: WorktreeStatus): boolean {
  return status.uncommittedFiles.length > 0 || status.unpushedCommits.length > 0;
}

export async function deleteAgent(projectPath: string, agentId: string, request: AgentDeleteRequest): Promise<AgentDeleteResult> {
  if (!isAgentDeleteMode(request.mode)) return { ok: false, message: `Unknown delete mode: ${String(request.mode)}` };
  if (request.mode === 'save-patch' && !request.savePath) return { ok: false, message: 'save-patch needs a file to save to' };
  if (dispatcher.isDispatcherPath(projectPath) || dispatcher.isDispatcherIdentityAgentId(agentId)) {
    return { ok: false, message: 'The Dispatcher can\'t be deleted.' };
  }
  return tel.flow('clubhouse.agent.delete', { attrs: [ATTR.deleteMode(MODE_ATTR[request.mode])] },
    () => withErrorType('delete_failed', () => withAgentLock(projectPath, agentId, () => deleteLocked(projectPath, agentId, request))),
    { classify: (r) => (r.ok ? 'ok' : isDeleteRefusal(r) ? { outcome: 'skipped' } : { error: 'delete_failed' }) });
}

/** Its orchestration gate as it is, to close while helpers settle and open again if the agent stays. */
function closeGate(agentId: string): () => void {
  if (!isOrchestrationEnabled(agentId)) return () => {};
  const crossProject = isCrossProjectEnabled(agentId);
  const control = orchestrationControl(agentId);
  setOrchestrationEnabled(agentId, false);
  return () => setOrchestrationEnabled(agentId, true, { crossProject, ...(control !== undefined && { control }) });
}

async function deleteLocked(projectPath: string, agentId: string, request: AgentDeleteRequest): Promise<AgentDeleteResult> {
  await assertDeleteReview(projectPath, agentId);
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  // Already gone (a failed creation rolled back, or another window deleted it):
  // there is nothing left to delete, so the row a window still shows can go (#3246).
  if (!agent) return { ok: true, deleted: true, message: 'It was already removed.' };

  const helpers = await listHelpersEverywhere(projectPath, agentId, { recursive: true });
  if (helpers.length > 0 && !request.helpers) {
    return {
      ok: false,
      message: `${agent.name} has ${helpers.length === 1 ? '1 helper' : `${helpers.length} helpers`}. Choose whether to dispose or keep ${helpers.length === 1 ? 'it' : 'them'}.`,
      needsHelperChoice: { helpers: helpers.map(({ config }) => ({ id: config.id, name: config.name })) },
    };
  }

  const checksWorktree = !!request.checkWorktree && losesWorktree(request.mode) && !!agent.worktreePath;
  // Checked before the helpers are touched, so a refusal changes nothing.
  if (checksWorktree) {
    const refused = worktreeRefusal(agent.name, await agentConfig.getWorktreeStatus(projectPath, agentId), request, 'Nothing was changed.');
    if (refused) return refused;
  }

  const reopenGate = closeGate(agentId);
  let deleted = false;
  try {
    let cascade: HelperCascadeResult | undefined;
    if (helpers.length > 0 && request.helpers) {
      cascade = await settleHelpers(projectPath, agentId, request.helpers, request.forceHelpers);
      // A start already under way when the gate closed can still land: settle it the same way.
      if (cascade.ok && (await listHelpersEverywhere(projectPath, agentId, { recursive: true })).length > 0) {
        const again = await settleHelpers(projectPath, agentId, request.helpers, request.forceHelpers);
        cascade = { ...again, helperIds: [...(cascade.helperIds ?? []), ...(again.helperIds ?? [])] };
      }
      if (!cascade.ok) {
        appLog('core:agent-config', 'info', 'Agent delete stopped by its helpers', {
          meta: { agentId, choice: request.helpers, blocked: cascade.blocked?.length ?? 0, failed: cascade.failed?.length ?? 0 },
        });
        return { ok: false, message: cascade.message, helpers: cascade };
      }
    }

    // Waits for each to exit, so none holds the worktree open (EBUSY on Windows).
    const quickAgents = runningQuickAgentsIn(agent.worktreePath);
    for (const quick of quickAgents) await killAgent(quick.id, quick.projectPath, undefined, 'user', { waitForExit: true });

    const stopped = { ...(cascade && { helpers: cascade }), ...(quickAgents.length > 0 && { stoppedQuickAgents: quickAgents.map((q) => q.id) }) };
    // A stop that fails, or leaves it running, refuses the delete: the worktree
    // isn't removed under a running agent. Settled helpers are still reported (#3199).
    if (isAgentRunning(agentId)) {
      let stopError: string | undefined;
      try {
        await killAgent(agentId, projectPath, undefined, 'user', { waitForExit: true, throwOnFailure: true });
      } catch (err) {
        // telemetry-exempt: the result carries the failure; the delete flow records it as delete_failed.
        stopError = err instanceof Error ? err.message : String(err);
      }
      if (stopError !== undefined || isAgentRunning(agentId)) {
        const settled = cascade ? 'Its helpers were settled, but it' : 'It';
        appLog('core:agent-config', 'warn', 'Agent delete stopped: the agent did not stop', { meta: { agentId, error: stopError ?? 'agent_still_running' } });
        return {
          ok: false,
          message: `${agent.name} couldn't be stopped${stopError ? ` (${stopError})` : ''}. ${settled} was not deleted.`,
          stopFailed: stopError !== undefined ? 'stop_failed' : 'agent_still_running',
          ...stopped,
        };
      }
    }

    // Again now nothing runs in it: work written while helpers settled and agents stopped isn't lost.
    if (checksWorktree) {
      const refused = worktreeRefusal(agent.name, await agentConfig.getWorktreeStatus(projectPath, agentId), request,
        `${cascade ? 'Its helpers were settled and it' : 'It'} was stopped, but nothing was deleted.`);
      if (refused) return { ...refused, ...stopped };
    }

    try {
      await assertDeleteReview(projectPath, agentId);
    } catch (err) {
      // telemetry-exempt: returned with every helper/stop consequence already incurred.
      return { ok: false, message: err instanceof Error ? err.message : String(err), ...stopped };
    }
    let result: DeleteResult;
    try {
      result = await deleteInMode(projectPath, agentId, request);
    } catch (err) {
      // Batch receipts must retain already-settled helpers even if a late guard or write throws.
      // telemetry-exempt: the receipt carries the failure and consequences.
      if (!hasDeleteReview()) throw err;
      return { ok: false, message: err instanceof Error ? err.message : String(err), ...stopped };
    }
    deleted = result.ok;
    return { ...result, ...(result.ok && { deleted: true }), ...stopped };
  } finally {
    if (!deleted) reopenGate();
  }
}

/** Unsaved work in the worktree, or a check that couldn't run, refuses a delete that would remove it. */
function worktreeRefusal(name: string, status: WorktreeStatus, request: AgentDeleteRequest, changed: string): AgentDeleteResult | null {
  if (status.checkError) {
    return {
      ok: false,
      message: `${name}'s worktree couldn't be checked for unsaved work (${status.checkError}), so it can't be deleted, even with force. Keeping its files on disk still works. ${changed}`,
      worktree: status,
    };
  }
  if (worktreeHasWork(status) && !request.forceWorktree) {
    return { ok: false, message: `${name}'s worktree has unsaved work that deleting it would lose. ${changed}`, worktree: status };
  }
  return null;
}

async function deleteInMode(projectPath: string, agentId: string, request: AgentDeleteRequest): Promise<DeleteResult> {
  let result: DeleteResult;
  switch (request.mode) {
    case 'commit-push': result = await agentConfig.deleteCommitAndPush(projectPath, agentId); break;
    case 'cleanup-branch': result = await agentConfig.deleteWithCleanupBranch(projectPath, agentId); break;
    case 'save-patch': result = await agentConfig.deleteSaveAsPatch(projectPath, agentId, request.savePath!); break;
    case 'force': result = await agentConfig.deleteForce(projectPath, agentId); break;
    case 'unregister': result = await agentConfig.deleteUnregister(projectPath, agentId); break;
  }
  return result;
}
