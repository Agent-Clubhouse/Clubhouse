/** Selected delivery metadata only. Receipts never retain running snapshots or payload/config objects. */
import { createHash } from 'crypto';
import type { DisplayReceipt } from '../display-settings';
import type { ManagedMcpProblem } from '../../../shared/managed-agents-types';
import type { DeliveryRecord } from './delivery';
import { delivered, failedDeliveries, mcpProblems } from './delivery-records';

const identities = new WeakMap<object, object>();
function identity(value: object | undefined): object | undefined {
  if (!value) return undefined;
  let token = identities.get(value);
  if (!token) { token = {}; identities.set(value, token); }
  return token;
}
const text = (value: unknown, nullable = false): boolean => typeof value === 'string' && value.length <= 2048 || nullable && value === null;
function limited(): never { throw new Error('Managed display delivery metadata exceeds the read limit.'); }
function invalid(): never { throw new Error('Managed display delivery metadata is unreadable.'); }

function selected(agentId: string, running: boolean) {
  if (!running) return { record: undefined as DeliveryRecord | undefined, failed: undefined as string | undefined, problems: undefined as ManagedMcpProblem[] | undefined, recordIdentity: undefined as object | undefined, problemIdentity: undefined as object | undefined, signature: 'stopped' };
  const source = delivered.get(agentId), failed = failedDeliveries.get(agentId), originalProblems = mcpProblems.get(agentId);
  // Present malformed values are uncertainty, never a verified absent record.
  if (delivered.has(agentId) && (!source || typeof source !== 'object')
    || failedDeliveries.has(agentId) && typeof failed !== 'string'
    || mcpProblems.has(agentId) && !Array.isArray(originalProblems)) invalid();
  let record: DeliveryRecord | undefined;
  if (source) {
    if (!text(source.fingerprint) || !source.fingerprint || !text(source.deliveredAt) || !Number.isFinite(new Date(source.deliveredAt).getTime()) || !source.parts || typeof source.parts !== 'object' || Array.isArray(source.parts)
      || !Array.isArray(source.order)) invalid();
    const ids = Object.keys(source.parts);
    if (ids.length > 100 || source.order.length > 102 || (source.deliveredSkillIds?.length ?? 0) > 100) limited();
    if (!source.order.every((id) => text(id))) invalid();
    const parts: DeliveryRecord['parts'] = {};
    for (const id of ids) {
      const part = source.parts[id];
      if (!text(id) || !part || !text(part.name) || !Number.isSafeInteger(part.revision) || part.revision < 1) invalid();
      parts[id] = { name: part.name, revision: part.revision };
    }
    if (source.deliveredSkillIds !== undefined && (!Array.isArray(source.deliveredSkillIds) || !source.deliveredSkillIds.every((id) => text(id)))
      || source.orchestrator !== undefined && !text(source.orchestrator)) invalid();
    const launch = source.launch;
    if (launch !== undefined && (!launch || typeof launch !== 'object' || Array.isArray(launch))) invalid();
    if (launch && (![launch.model, launch.effort, launch.access].every((value) => text(value, true))
      || launch.freeAgentMode !== null && typeof launch.freeAgentMode !== 'boolean'
      || launch.sandbox !== undefined && !text(launch.sandbox) || launch.approvalPolicy !== undefined && !text(launch.approvalPolicy))) invalid();
    // Explicit allowlist: never copy source.snapshot, provider config, env, or unknown fields.
    record = { fingerprint: source.fingerprint, deliveredAt: source.deliveredAt, parts, order: [...source.order],
      ...(source.orchestrator !== undefined && { orchestrator: source.orchestrator }),
      ...(source.deliveredSkillIds !== undefined && { deliveredSkillIds: [...source.deliveredSkillIds] }),
      ...(launch && { launch: { model: launch.model, effort: launch.effort, access: launch.access, freeAgentMode: launch.freeAgentMode,
        ...(launch.sandbox !== undefined && { sandbox: launch.sandbox }), ...(launch.approvalPolicy !== undefined && { approvalPolicy: launch.approvalPolicy }) } }) };
  }
  if (failed !== undefined && typeof failed !== 'string') invalid();
  if ((failed?.length ?? 0) > 8192) limited();
  let problems: ManagedMcpProblem[] | undefined;
  if (originalProblems !== undefined) {
    if (!Array.isArray(originalProblems)) invalid();
    if (originalProblems.length > 100) limited();
    let names = 0;
    problems = originalProblems.map((problem) => {
      if (!problem || !text(problem.server) || !Array.isArray(problem.missingEnv) || !problem.missingEnv.every((name) => text(name))) invalid();
      names += problem.missingEnv.length; if (names > 100) limited();
      return { server: problem.server, missingEnv: [...problem.missingEnv] };
    });
  }
  const signature = createHash('sha256').update(JSON.stringify({ record, failed, problems })).digest('hex');
  return { record, failed, problems, signature, recordIdentity: identity(source), problemIdentity: identity(originalProblems) };
}

/** Separate closure factory: only digest/tokens, never source.snapshot or detached source data. */
function receiptFor(agentId: string, running: boolean, currentRunning: () => boolean, expected: { signature: string; recordIdentity?: object; problemIdentity?: object }): DisplayReceipt {
  return { current: () => { try {
    if (currentRunning() !== running) return false;
    const now = selected(agentId, running);
    return now.signature === expected.signature && now.recordIdentity === expected.recordIdentity && now.problemIdentity === expected.problemIdentity;
  } catch { return false; } } };
}

export function readSelectedDeliveryForDisplay(agentId: string, running: boolean, currentRunning: () => boolean) {
  const data = selected(agentId, running);
  return { record: data.record, failed: data.failed, problems: data.problems,
    receipt: receiptFor(agentId, running, currentRunning, { signature: data.signature, recordIdentity: data.recordIdentity, problemIdentity: data.problemIdentity }) };
}
