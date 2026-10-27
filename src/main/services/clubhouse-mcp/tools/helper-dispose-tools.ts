/**
 * Helper dispose tools (#2229): `hand_off` and `dispose_helper`, for an
 * orchestrator's own direct helpers. Both are in the `orchestration` tool
 * group, so only agents with orchestration on see or can call them.
 *
 * - hand_off records how the orchestrator took a helper's work (pushed,
 *   merged or copied) on the helper's config. It never disposes.
 * - dispose_helper always runs the delete status checks (#2241). If work would
 *   be lost it changes nothing and returns the facts as a held result, and the
 *   orchestrator decides. `force` overrides uncommitted and unpushed work, but
 *   never a check that couldn't run or a creation another window owns. Under
 *   the "ask-everything" control level nothing is disposed here: the request
 *   goes to the user (force is refused).
 *
 * Disposing stops the helper, removes its worktree folder and its local
 * branch (only a branch Clubhouse created and that has not moved, see
 * deleteAgentBranch), and keeps its row with `disposedAt`. It never deletes a
 * remote branch.
 */

import * as path from 'path';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { agentRegistry } from '../../agent-registry';
import * as agentConfig from '../../agent-config';
import { getOrchestrationPolicy, withAgentLock } from '../../orchestration-policy';
import { isAgentRunning, killAgent } from '../../agent-system';
import { recordDisposeRequest } from '../../helper-dispose-requests';
import * as projectStore from '../../project-store';
import { appLog } from '../../log-service';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { findMainWindow } from '../../../ipc/window-handlers';
import { IPC } from '../../../../shared/ipc-channels';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import {
  HELPER_HANDOFF_HOWS,
  type DurableAgentConfig,
  type HelperDisposeChecks,
  type HelperDisposeRequest,
  type HelperHandoffHow,
} from '../../../../shared/types';

/** Longest handoff note kept. */
export const HANDOFF_NOTE_MAX_LENGTH = 2000;
/** Most uncommitted file paths listed in a held result. */
const MAX_LISTED_FILES = 50;

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(value: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The caller's project, or null when it isn't running under Clubhouse. */
function callerProject(agentId: string): string | null {
  return agentRegistry.get(agentId)?.projectPath ?? null;
}

/**
 * One of the caller's direct helpers, by id or (unambiguous, case-insensitive)
 * name. Disposed helpers are included so a repeated dispose answers plainly.
 */
async function findOwnHelper(
  projectPath: string,
  callerId: string,
  ref: string,
): Promise<{ helper: DurableAgentConfig } | { error: string }> {
  const helpers = await agentConfig.listHelpers(projectPath, callerId, { includeDisposed: true });
  const byId = helpers.find((h) => h.id === ref);
  if (byId) return { helper: byId };
  const wanted = ref.trim().toLowerCase();
  const byName = helpers.filter((h) => h.name.toLowerCase() === wanted);
  const live = byName.filter((h) => !isDisposedAgent(h));
  if (live.length === 1) return { helper: live[0] };
  if (live.length > 1) return { error: `More than one of your helpers is named "${ref}". Use its id.` };
  if (byName.length === 1) return { helper: byName[0] };
  return { error: `"${ref}" is not one of your helpers. Only an agent's own direct helpers can be handed off or disposed.` };
}

/** The facts a held or user-bound result reports. */
interface DisposeFacts {
  uncommittedFiles: number;
  uncommittedPaths?: string[];
  unpushedCommits: number;
  unmergedCommits: number | null;
  errors: string[];
}

/** The facts from `checks`, plus the uncommitted paths while the worktree is still there. */
async function factsFor(projectPath: string, helperId: string, checks: HelperDisposeChecks, listPaths = true): Promise<DisposeFacts> {
  const facts: DisposeFacts = {
    uncommittedFiles: checks.dirty,
    unpushedCommits: checks.unpushed,
    unmergedCommits: checks.unmerged,
    errors: checks.error ? [checks.error] : [],
  };
  if (listPaths && checks.dirty > 0) {
    try {
      const status = await agentConfig.getWorktreeStatus(projectPath, helperId);
      if (status.uncommittedFiles.length > 0) {
        facts.uncommittedPaths = status.uncommittedFiles.slice(0, MAX_LISTED_FILES).map((f) => f.path);
      }
    } catch {
      // telemetry-exempt: the file list is a courtesy; the count above is the fact
    }
  }
  return facts;
}

function workAtRisk(checks: HelperDisposeChecks): boolean {
  return checks.dirty > 0 || checks.unpushed > 0;
}

/**
 * Put the dispose in front of the user: the main window shows it under Needs
 * you with the check facts, and selecting it opens the dispose confirmation
 * (#2232). Returns false when there is no main window.
 */
function requestUserDispose(request: HelperDisposeRequest): boolean {
  const main = findMainWindow();
  if (!main) return false;
  main.webContents.send(IPC.AGENT.HELPER_DISPOSE_REQUEST, request);
  // So the user's answer can be reported to this orchestrator, once (#2232).
  recordDisposeRequest(request.projectPath, request.helperId, request.orchestratorId, request);
  return true;
}

/** Tell windows to reload the project's agents so a disposed helper leaves the rail. */
async function refreshRenderer(projectPath: string): Promise<void> {
  try {
    const project = (await projectStore.list()).find((p) => path.resolve(p.path) === path.resolve(projectPath));
    if (project) broadcastToAllWindows(IPC.WINDOW.REQUEST_DURABLE_RELOAD, project.id);
  } catch {
    // telemetry-exempt: the rail catches up on its next load
  }
}

// ── hand_off ─────────────────────────────────────────────────────────────

export async function handOff(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const ref = typeof args.helper === 'string' ? args.helper.trim() : '';
  if (!ref) return textResult('Missing required argument: helper', true);
  const how = args.how;
  if (typeof how !== 'string' || !HELPER_HANDOFF_HOWS.includes(how as HelperHandoffHow)) {
    return textResult(`how must be one of: ${HELPER_HANDOFF_HOWS.join(', ')}`, true);
  }
  const note = typeof args.note === 'string' ? args.note.trim().slice(0, HANDOFF_NOTE_MAX_LENGTH) : '';

  const projectPath = callerProject(callerId);
  if (!projectPath) return textResult('Clubhouse could not find the project you are running in.', true);
  return withAgentLock(projectPath, callerId, () => handOffLocked(projectPath, callerId, ref, how as HelperHandoffHow, note));
}

async function handOffLocked(projectPath: string, callerId: string, ref: string, how: HelperHandoffHow, note: string): Promise<McpToolResult> {
  try {
    const found = await findOwnHelper(projectPath, callerId, ref);
    if ('error' in found) return textResult(found.error, true);
    const { helper } = found;
    if (isDisposedAgent(helper)) return textResult(`${helper.name} was already disposed.`, true);
    const handoff = await agentConfig.setHelperHandoff(projectPath, helper.id, callerId, { how, note });
    appLog('core:orchestration', 'info', 'Helper handed off', {
      meta: { orchestratorId: callerId, helperId: helper.id, how },
    });
    return jsonResult({
      status: 'handed-off',
      helper: { id: helper.id, name: helper.name },
      handoff,
      message: `Recorded that you ${how} ${helper.name}'s work. ${helper.name} was not disposed; use dispose_helper when you are done with it.`,
    });
  } catch (err) {
    // telemetry-exempt: returned to the calling agent
    return textResult(`hand_off failed: ${errorText(err)}`, true);
  }
}

// ── dispose_helper ───────────────────────────────────────────────────────

export async function disposeHelperTool(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const ref = typeof args.helper === 'string' ? args.helper.trim() : '';
  if (!ref) return textResult('Missing required argument: helper', true);
  const force = args.force === true;

  const projectPath = callerProject(callerId);
  if (!projectPath) return textResult('Clubhouse could not find the project you are running in.', true);
  // Under the caller's policy lock, which turn-off also takes, so the helper
  // can't be released (or disposed by the cascade) in the middle of this call.
  return withAgentLock(projectPath, callerId, () => disposeLocked(projectPath, callerId, ref, force));
}

async function disposeLocked(projectPath: string, callerId: string, ref: string, force: boolean): Promise<McpToolResult> {
  try {
    const found = await findOwnHelper(projectPath, callerId, ref);
    if ('error' in found) return textResult(found.error, true);
    const { helper } = found;
    const who = { id: helper.id, name: helper.name };
    if (isDisposedAgent(helper)) {
      return jsonResult({ status: 'disposed', helper: who, message: `${helper.name} was already disposed.` });
    }

    const policy = await getOrchestrationPolicy(projectPath, callerId);
    if (!policy) return textResult('Clubhouse could not read your orchestration settings.', true);

    // Helpers of helpers come later in the epic; until then their parent has
    // to settle them, so one with helpers of its own is never disposed here.
    const nested = await agentConfig.listHelpers(projectPath, helper.id);
    if (nested.length > 0) {
      return jsonResult({
        status: 'held',
        helper: who,
        reason: 'has-helpers',
        canForce: false,
        message: `${helper.name} has ${nested.length} helper(s) of its own. They have to be disposed or kept first.`,
      });
    }

    const checks = await agentConfig.getDisposeChecks(projectPath, helper.id);
    const facts = await factsFor(projectPath, helper.id, checks);

    if (policy.control === 'ask-everything') {
      const delivered = requestUserDispose({
        projectPath,
        orchestratorId: callerId,
        helperId: helper.id,
        helperName: helper.name,
        checks,
        forceRequested: force,
      });
      appLog('core:orchestration', 'info', 'Helper dispose sent to the user (ask-everything)', {
        meta: { orchestratorId: callerId, helperId: helper.id, forceRequested: force, delivered },
      });
      return jsonResult({
        status: 'sent-to-user',
        helper: who,
        delivered,
        ...facts,
        ...(force ? { forceRefused: true } : {}),
        message: `${force ? 'Force is refused because the user approves every dispose. ' : ''}`
          + (delivered
            ? `The user decides whether ${helper.name} is disposed. Nothing was changed.`
            : `No Clubhouse window is open to ask the user. Nothing was changed; ask the user directly.`),
      });
    }

    if (checks.error) {
      return jsonResult({
        status: 'held',
        helper: who,
        reason: 'check-failed',
        canForce: false,
        ...facts,
        message: `${helper.name} wasn't disposed: ${checks.error}. force can't override this; resolve it or ask the user.`,
      });
    }
    if (workAtRisk(checks) && !force) {
      return jsonResult({
        status: 'held',
        helper: who,
        reason: 'work-at-risk',
        canForce: true,
        ...facts,
        message: `${helper.name} wasn't disposed because disposing would lose work. `
          + 'Save or hand off the work, check with the user, or call dispose_helper again with force: true.',
      });
    }

    // Stop it so it no longer holds its worktree open (EBUSY on Windows).
    const wasRunning = isAgentRunning(helper.id);
    if (wasRunning) {
      await killAgent(helper.id, projectPath, undefined, 'agent_tool', { waitForExit: true });
    }

    // disposeHelper checks again now the helper is stopped; force never
    // overrides a check that couldn't run.
    const result = await agentConfig.disposeHelper(projectPath, helper.id, { force, expectedParentId: callerId });
    if (!result.ok) {
      const after = result.checks;
      if (after && (after.error || workAtRisk(after))) {
        return jsonResult({
          status: 'held',
          helper: who,
          reason: after.error ? 'check-failed' : 'work-at-risk',
          canForce: !after.error,
          stopped: wasRunning,
          ...(await factsFor(projectPath, helper.id, after)),
          message: `${result.message}.${wasRunning ? ` ${helper.name} was stopped but not disposed.` : ''}`,
        });
      }
      if (result.worktreeRemoved) {
        await refreshRenderer(projectPath);
        return textResult(
          `dispose_helper failed: ${helper.name} stopped being your helper while it was being disposed. `
            + 'Its worktree folder was already removed, so it was not marked disposed and is now an ordinary agent without a worktree.',
          true,
        );
      }
      return textResult(`dispose_helper failed: ${result.message}`, true);
    }

    await refreshRenderer(projectPath);
    // Report what the re-check after the stop found: that is what was lost.
    const final = result.checks ?? checks;
    const forced = force && workAtRisk(final);
    appLog('core:orchestration', 'info', 'Helper disposed by its orchestrator', {
      meta: { orchestratorId: callerId, helperId: helper.id, forced },
    });
    return jsonResult({
      status: 'disposed',
      helper: who,
      forced,
      ...(await factsFor(projectPath, helper.id, final, false)),
      message: `${helper.name} was ${wasRunning ? 'stopped and ' : ''}disposed. Its worktree folder and local branch are gone; any pushed remote branch was kept.`,
    });
  } catch (err) {
    // telemetry-exempt: returned to the calling agent
    return textResult(`dispose_helper failed: ${errorText(err)}`, true);
  }
}

/** Register `hand_off` and `dispose_helper` in the orchestration tool group. */
export function registerHelperDisposeTools(): void {
  registerGlobalTool(
    'hand_off',
    {
      description:
        'Record how you took one of your helpers\' work: "pushed" (it pushed a branch or PR), ' +
        '"merged" (you merged its branch) or "copied" (you copied its changes). ' +
        'This does not dispose the helper; call dispose_helper afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          helper: { type: 'string', description: 'The helper\'s agent id or name. Only your own direct helpers.' },
          how: { type: 'string', enum: [...HELPER_HANDOFF_HOWS], description: 'How you took the work.' },
          note: { type: 'string', description: `Short note on what you took (PR, commit, files). Up to ${HANDOFF_NOTE_MAX_LENGTH} characters.` },
        },
        required: ['helper', 'how'],
      },
    },
    handOff,
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'dispose_helper',
    {
      description:
        'Dispose one of your helpers: stop it and remove its worktree folder and local branch. ' +
        'A pushed remote branch is never deleted. Clubhouse checks first for uncommitted files, ' +
        'unpushed commits and unmerged commits. If work would be lost, nothing changes and the result ' +
        'has status "held" with the facts; decide whether to save the work, ask the user, or call ' +
        'again with force: true. force overrides lost work, never a check that couldn\'t run. ' +
        'If the user asked to approve everything, the request goes to the user and force is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          helper: { type: 'string', description: 'The helper\'s agent id or name. Only your own direct helpers.' },
          force: { type: 'boolean', description: 'Dispose even though uncommitted or unpushed work would be lost.' },
        },
        required: ['helper'],
      },
    },
    disposeHelperTool,
    { group: 'orchestration' },
  );
}
