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
 *    If any helper is left, the agent is not deleted.
 * 4. The agent is stopped and deleted in the chosen mode.
 *
 * It runs under the agent's lock, so a dispose_helper or orchestration change
 * for the same agent can't run in the middle. Nothing here asks the user.
 */

import * as agentConfig from './agent-config';
import { isAgentRunning, killAgent } from './agent-system';
import { listHelpersEverywhere } from './helper-index';
import { settleHelpers, withAgentLock } from './orchestration-policy';
import * as dispatcher from './dispatcher/dispatcher-service';
import { appLog } from './log-service';
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
  return withAgentLock(projectPath, agentId, () => deleteLocked(projectPath, agentId, request));
}

async function deleteLocked(projectPath: string, agentId: string, request: AgentDeleteRequest): Promise<AgentDeleteResult> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const helpers = await listHelpersEverywhere(projectPath, agentId, { recursive: true });
  if (helpers.length > 0 && !request.helpers) {
    return {
      ok: false,
      message: `${agent.name} has ${helpers.length === 1 ? '1 helper' : `${helpers.length} helpers`}. Choose whether to dispose or keep ${helpers.length === 1 ? 'it' : 'them'}.`,
      needsHelperChoice: { helpers: helpers.map(({ config }) => ({ id: config.id, name: config.name })) },
    };
  }

  // Checked before the helpers are touched, so a refusal changes nothing.
  if (request.checkWorktree && losesWorktree(request.mode) && agent.worktreePath) {
    const status = await agentConfig.getWorktreeStatus(projectPath, agentId);
    if (status.checkError) {
      return {
        ok: false,
        message: `${agent.name}'s worktree couldn't be checked for unsaved work (${status.checkError}), so it can't be deleted, even with force. Keeping its files on disk still works.`,
        worktree: status,
      };
    }
    if (worktreeHasWork(status) && !request.forceWorktree) {
      return {
        ok: false,
        message: `${agent.name}'s worktree has unsaved work that deleting it would lose. Nothing was changed.`,
        worktree: status,
      };
    }
  }

  let cascade: HelperCascadeResult | undefined;
  if (helpers.length > 0 && request.helpers) {
    cascade = await settleHelpers(projectPath, agentId, request.helpers, request.forceHelpers);
    if (!cascade.ok) {
      appLog('core:agent-config', 'info', 'Agent delete stopped by its helpers', {
        meta: { agentId, choice: request.helpers, blocked: cascade.blocked?.length ?? 0, failed: cascade.failed?.length ?? 0 },
      });
      return { ok: false, message: cascade.message, helpers: cascade };
    }
  }

  if (isAgentRunning(agentId)) await killAgent(agentId, projectPath, undefined, 'user', { waitForExit: true });

  let result: DeleteResult;
  switch (request.mode) {
    case 'commit-push': result = await agentConfig.deleteCommitAndPush(projectPath, agentId); break;
    case 'cleanup-branch': result = await agentConfig.deleteWithCleanupBranch(projectPath, agentId); break;
    case 'save-patch': result = await agentConfig.deleteSaveAsPatch(projectPath, agentId, request.savePath!); break;
    case 'force': result = await agentConfig.deleteForce(projectPath, agentId); break;
    case 'unregister': result = await agentConfig.deleteUnregister(projectPath, agentId); break;
  }
  return { ...result, ...(result.ok && { deleted: true }), ...(cascade && { helpers: cascade }) };
}
