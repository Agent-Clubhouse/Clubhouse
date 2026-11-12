import { agentRegistry } from '../agent-registry';
import { canonicalProjectPath } from '../project-store';
import { callKey, type ConsumedCallApproval } from '../grant-requests';
import { askFirst, describeCallsForAsk } from '../clubhouse-mcp/ask-first';
import { resolveArgTargets } from '../clubhouse-mcp/arg-targets';
import { checkToolGrant } from '../clubhouse-mcp/grant-check';
import { grantApprovalContext } from '../clubhouse-mcp/tool-registry';
import { isDispatcherAgent } from '../clubhouse-mcp/dispatcher-gate';
import { mcpCallAccess } from '../clubhouse-mcp/mcp-call-gate';
import type { ToolGrantDeclaration } from '../clubhouse-mcp/tool-grants';
import { ImportError, type ImportPlan } from './types';
import type { ImportAuthorization, PreviewAuthorization, PreviewScope } from './service';

export const IMPORT_GRANT: ToolGrantDeclaration = {
  actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] }, askHandledByTool: true,
};
const CHECK_GRANT: ToolGrantDeclaration = {
  actions: ['project.add'], target: 'project_arg', from: { args: ['destination'] },
};
const reviews = new Map<string, string>();

function review(tool: string, args: Record<string, unknown>, description: string): void {
  const key = callKey('', tool, args);
  reviews.delete(key);
  reviews.set(key, description);
  if (reviews.size > 64) reviews.delete(reviews.keys().next().value!);
  describeCallsForAsk(tool, (actualArgs) => reviews.get(callKey('', tool, actualArgs)));
}

async function snapshot(agentId: string, tool: string, args: Record<string, unknown>, scope: ImportPlan | PreviewScope) {
  const targets = await resolveArgTargets(agentId, CHECK_GRANT, args);
  for (const resolved of targets.values()) {
    for (const target of resolved ?? []) {
      if (target.projectPath) target.projectPath = await canonicalProjectPath(target.projectPath);
    }
  }
  const resolved = [...targets.values()].flatMap((target) => target ?? []);
  if (resolved.length !== 1 || resolved[0].kind !== 'project' || resolved[0].projectPath !== scope.destination) {
    throw new ImportError('approval_changed', 'The current canonical permission target differs from the reviewed destination. Preview and approve the new placement.');
  }
  const caller = agentRegistry.get(agentId);
  if (!caller?.nonce || !isDispatcherAgent(agentId) || mcpCallAccess(agentId, caller.projectPath) !== 'open') {
    throw new ImportError('caller_changed', 'The running Dispatcher/session changed. Preview again and obtain fresh approval; no further import effects were authorized.');
  }
  const check = checkToolGrant(agentId, CHECK_GRANT, args, undefined, targets);
  if (check.ok === false && check.reason !== 'ask_first') {
    throw new ImportError('permission_denied', 'Current project.add permission does not allow this destination. Only the user can restore that permission. Existing import files/projects are preserved.');
  }
  return {
    check,
    // The session nonce is hashed only; it is never shown, logged, saved in the import ledger or forwarded.
    context: callKey(agentId, tool, {
      scope,
      policy: grantApprovalContext(agentId, tool, args, IMPORT_GRANT, targets),
      session: caller.nonce,
    }),
  };
}

async function authorize(
  agentId: string, tool: string, args: Record<string, unknown>, scope: ImportPlan | PreviewScope,
  description: string, alwaysAsk: boolean,
) {
  const initial = await snapshot(agentId, tool, args, scope);
  const asks = [{ action: 'project.add' as const, where: scope.destination }];
  let originalProof: ConsumedCallApproval | undefined;
  const assertCurrent = async () => {
    if (alwaysAsk && !originalProof?.requestId) {
      throw new ImportError('approval_mismatch', 'A genuine original per-import human approval is required; preview ids and Allow grants are not approval.');
    }
    if ((await snapshot(agentId, tool, args, scope)).context !== (originalProof?.scope.context ?? initial.context)) {
      throw new ImportError('approval_changed', 'Caller, session, policy, canonical destination or import scope changed. Preview and obtain fresh approval before any further effects.');
    }
  };
  if (alwaysAsk || initial.check.ok === false) {
    review(tool, args, description);
    const outcome = await askFirst(agentId, tool, args, asks, initial.context);
    if (outcome.kind !== 'approved') return outcome;
    const original = outcome.approval;
    if (!original?.requestId || original.scope.context !== initial.context
      || original.scope.asks.length !== asks.length
      || !asks.every((ask) => original.scope.asks.some((held) => held.action === ask.action && held.where === ask.where))) {
      throw new ImportError('approval_mismatch', 'The original human approval does not cover this exact import. Preview and approve again; no effect was authorized.');
    }
    originalProof = structuredClone(original);
  }
  await assertCurrent();
  return { kind: 'approved' as const, assertCurrent };
}

export function previewAuthorization(agentId: string): PreviewAuthorization {
  return (scope) => {
    const args = {
      url: scope.url, destination: scope.destination,
      ...(scope.branch !== undefined && { branch: scope.branch }),
    };
    const description = [
      'Preview only: use existing authorized GitHub/Git access to read this repository\'s branch metadata and save a bounded app-owned import plan.',
      `Repository: ${scope.url}`,
      `Canonical destination: ${JSON.stringify(scope.destination)}`,
      `Branch choice: ${scope.branch ?? 'read the actual advertised default; do not assume main'}`,
      'No destination directory, checkout, project, agent creation or agent start is authorized by this preview.',
    ].join('\n');
    return authorize(agentId, 'preview_github_import', args, scope, description, false);
  };
}

export function importAuthorization(agentId: string): ImportAuthorization {
  return (plan) => {
    const args = { planId: plan.id, destination: plan.destination };
    const description = [
      'Import this exact reviewed GitHub repository. A generic Allow permission is not approval for this import.',
      `Repository: ${plan.url}`,
      `Canonical destination: ${JSON.stringify(plan.destination)}`,
      `Selected branch: ${plan.branch}; exact commit: ${plan.commit}`,
      `Advertised default branch: ${plan.defaultBranch}; default tip: ${plan.headCommit}`,
      `Preview expires: ${new Date(plan.expiresAt).toISOString()}`,
      ...plan.effects.map((effect, index) => `${index + 1}. ${effect}`),
      'Cancellation preserves all partial files. No agent creation, connection, authority change, repository setup or agent start is included.',
    ].join('\n');
    return authorize(agentId, 'import_github_repository', args, plan, description, true);
  };
}
