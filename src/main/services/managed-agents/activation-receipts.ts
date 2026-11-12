import { randomUUID } from 'node:crypto';
import { appendSettingsAudit, currentSettingsOrigin } from '../settings-audit';
import { appLog } from '../log-service';
import { isCatalogId } from '../asset-catalog/validation';
import { ManagedError } from './service';

export interface ManagedPartRevision {
  id: string;
  revision: number;
}

export interface ManagedRestartReceipt {
  id: string;
  agentId: string;
  actorId?: string;
  requestedAt: string;
  finishedAt?: string;
  whenTurnEnds: boolean;
  fresh: boolean;
  outcome: 'requested' | 'completed' | 'failed';
  requestedParts: ManagedPartRevision[];
  resumed?: boolean;
  noSession?: boolean;
  failure?: 'restart_failed';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revisions(value: unknown): value is ManagedPartRevision[] {
  return Array.isArray(value) && value.every((p) => record(p)
    && isCatalogId(p.id) && typeof p.revision === 'number' && Number.isInteger(p.revision) && p.revision > 0);
}

/** Reconstruct the allowlisted shape; persisted history never carries config content or errors. */
export function readRestartReceipt(value: unknown): ManagedRestartReceipt | null {
  if (!record(value) || !isCatalogId(value.id) || !isCatalogId(value.agentId)
    || (value.actorId !== undefined && !isCatalogId(value.actorId))
    || typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt))
    || (value.finishedAt !== undefined && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))))
    || typeof value.whenTurnEnds !== 'boolean' || typeof value.fresh !== 'boolean'
    || !['requested', 'completed', 'failed'].includes(String(value.outcome)) || !revisions(value.requestedParts)) return null;
  return {
    id: value.id, agentId: value.agentId, requestedAt: value.requestedAt,
    whenTurnEnds: value.whenTurnEnds, fresh: value.fresh, outcome: value.outcome as ManagedRestartReceipt['outcome'],
    requestedParts: value.requestedParts.map(({ id, revision }) => ({ id, revision })),
    ...(typeof value.actorId === 'string' && { actorId: value.actorId }),
    ...(typeof value.finishedAt === 'string' && { finishedAt: value.finishedAt }),
    ...(typeof value.resumed === 'boolean' && { resumed: value.resumed }),
    ...(value.noSession === true && { noSession: true }),
    ...(value.failure === 'restart_failed' && { failure: value.failure }),
  };
}

export async function restartWithReceipt<T extends { resumed: boolean; noSession?: boolean }>(
  input: { agentId: string; whenTurnEnds: boolean; fresh: boolean; requestedParts: ManagedPartRevision[] },
  save: (receipt: ManagedRestartReceipt) => Promise<void>,
  restart: () => Promise<T>,
): Promise<T> {
  const origin = currentSettingsOrigin();
  const receipt: ManagedRestartReceipt = {
    ...input, id: randomUUID(), requestedAt: new Date().toISOString(), outcome: 'requested',
    ...(origin.actorId && { actorId: origin.actorId }),
  };
  // Persist intent before any lifecycle side effect. A failed write aborts the restart.
  try { await save(receipt); } catch {
    throw new ManagedError('failed', 'Restart was not attempted because its intent receipt could not be saved. Check local storage before retrying.');
  }
  await appendSettingsAudit({ ...origin, scope: 'agent', targetId: input.agentId, key: 'managed.restart.requested', changed: true, outcome: 'ok' });
  let result: T;
  try {
    result = await restart();
  } catch (error) {
    const failed: ManagedRestartReceipt = { ...receipt, outcome: 'failed', finishedAt: new Date().toISOString(), failure: 'restart_failed' };
    try { await save(failed); } catch {
      // telemetry-exempt: a safe failure is rethrown, and the unresolved persisted intent remains visible.
      appLog('core:managed', 'warn', 'Could not persist a failed restart receipt', { meta: { agentId: input.agentId, receiptId: receipt.id } });
    }
    await appendSettingsAudit({ ...origin, scope: 'agent', targetId: input.agentId, key: 'managed.restart.failed', changed: true, outcome: 'error', code: 'restart_failed' });
    appLog('core:managed', 'warn', 'Managed restart failed', { meta: { agentId: input.agentId, receiptId: receipt.id, code: error instanceof ManagedError ? error.code : 'restart_failed' } });
    throw new ManagedError(error instanceof ManagedError ? error.code : 'failed',
      'Managed restart failed. Inspect its lifecycle receipt and current target state before retrying. Provider loading is not confirmed.');
  }
  try {
    await save({ ...receipt, outcome: 'completed', finishedAt: new Date().toISOString(), resumed: result.resumed, ...(result.noSession && { noSession: true }) });
  } catch {
    throw new ManagedError('failed', 'The restart returned, but its outcome receipt could not be saved. Do not retry automatically; inspect the running agent. Provider loading is not confirmed.');
  }
  await appendSettingsAudit({ ...origin, scope: 'agent', targetId: input.agentId, key: 'managed.restart.completed', changed: true, outcome: 'ok' });
  return result;
}
