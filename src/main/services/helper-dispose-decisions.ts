/**
 * The user's answers to helper disposes (#2232): disposing one from the UI or
 * a paired phone, and telling the orchestrator that asked what was decided.
 */

import * as agentConfig from './agent-config';
import * as agentSystem from './agent-system';
import * as orchestrationPolicy from './orchestration-policy';
import { appLog } from './log-service';
import { getAgentRuntime } from './agent-runtime';
import { isAgentStoppingError } from './agent-runtime/agent-stopping';
import { takeDisposeRequest } from './helper-dispose-requests';
import type { HelperDisposeChecks, HelperDisposeDecision, HelperDisposeResult } from '../../shared/types';

/** Work disposing would lose. A check that couldn't run is handled on its own: force never overrides it. */
export function workAtRisk(checks: HelperDisposeChecks): boolean {
  return checks.dirty > 0 || checks.unpushed > 0;
}

/** More at risk now than the user saw: a failed check, or more dirty files or unpushed commits. */
export function worseThan(now: HelperDisposeChecks, seen: HelperDisposeChecks): boolean {
  return (!!now.error && !seen.error) || now.dirty > seen.dirty || now.unpushed > seen.unpushed;
}

/**
 * Dispose a helper for the user (#2232), in the dispose_helper tool's order:
 * check; refuse a failed check, or work at risk without force, before
 * stopping anything; stop it if main has it running (never the renderer's
 * status, which can be stale) and wait for the exit; check again, and refuse
 * with `changed` when more is at risk than the user confirmed; then dispose.
 * Runs under the orchestrator's policy lock, as the tool and turn-off do.
 */
export async function disposeHelperForUser(
  projectPath: string,
  helperId: string,
  options: { force: boolean; seen?: HelperDisposeChecks },
): Promise<HelperDisposeResult> {
  const config = await agentConfig.getDurableConfig(projectPath, helperId);
  if (!config) return { ok: false, message: 'Agent not found' };
  const parentId = config.parentAgentId;
  if (!parentId) return { ok: false, message: `${config.name} isn't a helper` };
  return orchestrationPolicy.withAgentLock(projectPath, parentId, async () => {
    const checks = await agentConfig.getDisposeChecks(projectPath, helperId);
    if (checks.error) {
      return { ok: false, message: `${config.name} wasn't disposed (${checks.error})`, checks };
    }
    if (workAtRisk(checks) && !options.force) {
      return { ok: false, message: `${config.name} has work that disposing would lose`, checks };
    }
    const seen = options.seen ?? checks;
    if (worseThan(checks, seen)) {
      return { ok: false, changed: true, message: `${config.name} has more unsaved work than when you confirmed`, checks };
    }

    let stopped = false;
    if (agentSystem.isAgentRunning(helperId)) {
      // It holds its worktree open while it runs (EBUSY on Windows).
      await agentSystem.killAgent(helperId, projectPath, undefined, 'user', { waitForExit: true });
      stopped = true;
      const after = await agentConfig.getDisposeChecks(projectPath, helperId);
      if (after.error || worseThan(after, seen)) {
        return {
          ok: false,
          changed: true,
          stopped,
          message: after.error
            ? `${config.name} was stopped, then couldn't be checked (${after.error})`
            : `${config.name} saved more work before it stopped`,
          checks: after,
        };
      }
    }

    const result = await agentConfig.disposeHelper(projectPath, helperId, { force: options.force, expectedParentId: parentId });
    return { ok: result.ok, message: result.message, ...(result.checks ? { checks: result.checks } : {}), ...(stopped ? { stopped } : {}) };
  });
}

/**
 * Tell an orchestrator what the user decided about the dispose it asked for
 * (#2229 ask-everything), through its runtime as the helper tools do. Main
 * picks the orchestrator (the helper's parent) and the text; the renderer
 * only names the helper and the decision. Refused unless main sent that
 * parent's request for this helper, and each request is answered once.
 */
export async function reportDisposeDecision(
  projectPath: string,
  helperId: string,
  decision: HelperDisposeDecision,
): Promise<{ ok: boolean; delivered: boolean; message: string }> {
  const config = await agentConfig.getDurableConfig(projectPath, helperId);
  if (!config) return { ok: false, delivered: false, message: 'Agent not found' };
  const parentId = config.parentAgentId;
  if (!parentId) return { ok: false, delivered: false, message: `${config.name} isn't a helper` };
  if (!takeDisposeRequest(projectPath, helperId, parentId)) {
    return { ok: false, delivered: false, message: `No dispose request for ${config.name} is waiting on the user` };
  }
  const runtime = getAgentRuntime(parentId);
  if (!runtime) return { ok: true, delivered: false, message: 'The orchestrator isn\'t running' };
  const text = decision === 'disposed'
    ? `The user approved your request and disposed of ${config.name}.`
    : `The user declined your request to dispose of ${config.name}. Nothing was changed.`;
  try {
    await runtime.sendMessage(`[Clubhouse] ${text}`, {
      source: 'mcp', taskId: `dispose_${Date.now().toString(36)}`, routed: [{ fromClubhouse: true, text }],
    });
    return { ok: true, delivered: true, message: 'Reported' };
  } catch (err) {
    // telemetry-exempt: logged; the user's decision already stands
    const message = isAgentStoppingError(err)
      ? 'The orchestrator is shutting down, so it was not told.'
      : err instanceof Error ? err.message : String(err);
    appLog('core:orchestration', 'warn', 'Dispose decision not delivered', { meta: { orchestratorId: parentId, error: message } });
    return { ok: true, delivered: false, message };
  }
}
