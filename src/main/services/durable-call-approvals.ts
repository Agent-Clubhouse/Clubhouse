import { GRANT_ACTIONS, type GrantAction } from '../../shared/agent-grants';
import { isMachineFingerprint } from '../../shared/agent-address';
import type { AnnexDeliveryEpoch } from '../../shared/annex-delivery';
import { GRANT_REQUEST_TTL_MS } from '../../shared/grant-requests';
import { DELIVERY_MAX_AGE_MS, DELIVERY_RETENTION_MS, deliveryHash } from './annex-delivery-store';
import { createSettingsStore } from './settings-store';

export const DURABLE_APPROVAL_MAX_RECORDS = 2_000;
export const DURABLE_APPROVAL_MAX_BYTES = 4 * 1024 * 1024;
const PREPARED_MAX = 256;

export interface DurableApprovalScope {
  context: string;
  asks: readonly { action: GrantAction; where: string }[];
}

/** Main resolves every field before asking; no field is a model-supplied approval. */
export interface DurableCallIdentity {
  callerId: string;
  callKey: string;
  toolName: string;
  protocol: 'federation' | 'handoff';
  operation: string;
  machineId: string;
  targetId: string;
  epoch: AnnexDeliveryEpoch;
  displayTarget: string;
  policyContext: string;
}

export interface PreparedDurableCall extends DurableCallIdentity {
  commandId: string;
  wirePayloadHash: string;
  scope: DurableApprovalScope;
}

export interface DurableApprovalReference {
  requestId: string;
}

/** Supplied only by the original grant-request answer path after an actual Allow click. */
export interface AnsweredOriginalCall {
  requestId: string;
  callerId: string;
  callKey: string;
  scope: DurableApprovalScope;
  expiresAt: number;
}

interface Receipt {
  requestId: string;
  intent: PreparedDurableCall;
  approvedAt: number;
  claimBy: number;
  boundAt?: number;
  revoked?: true;
}
interface ApprovalFile { version: 1; receipts: Receipt[] }
export type DurableApprovalRefusal = 'grant_refused' | 'approval_missing_or_invalid' | 'approval_expired' | 'approval_changed' | 'approval_not_bound' | 'approval_revoked';
export type DurableApprovalCheck = { allowed: true } | { allowed: false; reason: DurableApprovalRefusal };

export class DurableApprovalError extends Error {
  constructor(public readonly code: 'approval_store_unreadable' | 'approval_store_full' | 'approval_not_original' | 'approval_expired' | 'approval_changed', message: string) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validScope(value: unknown): value is DurableApprovalScope {
  return object(value) && hash(value.context) && Array.isArray(value.asks) && value.asks.length > 0 && value.asks.length <= 20
    && value.asks.every((ask) => object(ask) && GRANT_ACTIONS.some((action) => action === ask.action) && text(ask.where, 1_000));
}
function validIntent(value: unknown): value is PreparedDurableCall {
  return object(value) && text(value.commandId) && text(value.callerId) && text(value.callKey, 1_000)
    && text(value.toolName) && (value.protocol === 'federation' || value.protocol === 'handoff')
    && text(value.operation) && typeof value.machineId === 'string' && isMachineFingerprint(value.machineId)
    && text(value.targetId) && !value.targetId.includes('@') && text(value.displayTarget, 500)
    && object(value.epoch) && text(value.epoch.sender) && text(value.epoch.receiver)
    && hash(value.policyContext) && hash(value.wirePayloadHash) && validScope(value.scope)
    && value.scope.context === intentContext(value);
}
function intentContext(intent: Record<string, unknown>): string {
  const { scope, ...identity } = intent;
  return deliveryHash({ ...identity, asks: object(scope) ? scope.asks : undefined });
}
function validReceipt(value: unknown): value is Receipt {
  return object(value) && text(value.requestId) && validIntent(value.intent)
    && finite(value.approvedAt) && finite(value.claimBy) && value.claimBy > value.approvedAt
    && value.claimBy - value.approvedAt <= GRANT_REQUEST_TTL_MS
    && (value.boundAt === undefined || (finite(value.boundAt) && value.boundAt >= value.approvedAt && value.boundAt < value.claimBy))
    && (value.revoked === undefined || value.revoked === true);
}
function parseApprovalFile(raw: unknown): ApprovalFile {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.receipts)
    || raw.receipts.length > DURABLE_APPROVAL_MAX_RECORDS || !raw.receipts.every(validReceipt)
    || new Set(raw.receipts.map((receipt: Receipt) => receipt.requestId)).size !== raw.receipts.length) {
    throw new Error('Invalid durable approval records');
  }
  return { version: 1, receipts: raw.receipts };
}

/**
 * No token/boolean issuer: approval accepts a request id and reads its original
 * answered scope from Main. Transport receives only the resulting local reference.
 */
export function createDurableCallApprovals(
  readAnsweredOriginal: (requestId: string) => AnsweredOriginalCall | undefined,
  filename = 'durable-call-approvals.json',
) {
  let loadError: unknown;
  const store = createSettingsStore<ApprovalFile>(filename, { version: 1, receipts: [] }, parseApprovalFile, {
    atomic: true, mode: 0o600, rollBackFailedSaves: true,
    onLoad(result) {
      if ('error' in result && (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT') loadError = result.error;
      if ('raw' in result) {
        try {
          if (Buffer.byteLength(result.raw) > DURABLE_APPROVAL_MAX_BYTES) throw new Error('Oversized durable approval store');
          // Settings defaults must not fill missing authority-bearing file fields.
          parseApprovalFile(JSON.parse(result.raw));
        } catch (error) {
          // telemetry-exempt: latched and surfaced as approval_store_unreadable on every access
          loadError = error;
        }
      }
    },
  });
  let committed: ApprovalFile | undefined;
  let lock = Promise.resolve();
  const prepared = new Map<string, { intent: PreparedDurableCall; expiresAt: number }>();
  const revoked = new Map<string, number>();
  const pruneRevocations = (now: number): void => {
    for (const [context, until] of revoked) if (until <= now) revoked.delete(context);
  };
  const revokeIntent = (context: string, until: number): void => { revoked.set(context, Math.max(revoked.get(context) ?? 0, until)); };
  const get = (): ApprovalFile => {
    if (!committed) {
      const loaded = store.get();
      if (loadError) throw new DurableApprovalError('approval_store_unreadable', 'The approval store is unreadable. No durable approval can be used until it is repaired.');
      committed = structuredClone(loaded);
    }
    return structuredClone(committed);
  };
  const update = (change: (file: ApprovalFile) => void | boolean, now: number): Promise<void> => {
    const task = lock.catch(() => {}).then(async () => {
      const file = get();
      file.receipts = file.receipts.filter((receipt) => now < (receipt.boundAt === undefined ? receipt.claimBy : receipt.boundAt + DELIVERY_RETENTION_MS));
      if (change(file) === false) return;
      if (file.receipts.length > DURABLE_APPROVAL_MAX_RECORDS || Buffer.byteLength(JSON.stringify(file)) > DURABLE_APPROVAL_MAX_BYTES) {
        throw new DurableApprovalError('approval_store_full', 'The approval store is full. Existing unexpired approvals were not discarded.');
      }
      await store.save(file);
      committed = structuredClone(file);
    });
    lock = task;
    return task;
  };
  const check = (reference: unknown, actual: PreparedDurableCall, freshGrant: 'allow' | 'ask' | 'refuse', now: number, requireBound: boolean): DurableApprovalCheck => {
    if (freshGrant === 'refuse') return { allowed: false, reason: 'grant_refused' };
    if (!object(reference) || Object.keys(reference).length !== 1 || !text(reference.requestId) || !validIntent(actual)) {
      return { allowed: false, reason: 'approval_missing_or_invalid' };
    }
    const receipt = get().receipts.find((entry) => entry.requestId === reference.requestId);
    if (!receipt) return { allowed: false, reason: 'approval_missing_or_invalid' };
    if (receipt.revoked || (revoked.get(receipt.intent.scope.context) ?? 0) > now) return { allowed: false, reason: 'approval_revoked' };
    if (now >= (receipt.boundAt === undefined ? receipt.claimBy : receipt.boundAt + DELIVERY_MAX_AGE_MS)) return { allowed: false, reason: 'approval_expired' };
    if (receipt.intent.scope.context !== actual.scope.context) return { allowed: false, reason: 'approval_changed' };
    if (requireBound && receipt.boundAt === undefined) return { allowed: false, reason: 'approval_not_bound' };
    return { allowed: true };
  };
  return {
    /** Hash and id come from transport's shared final-envelope preparation, never a separate preview. */
    prepare(identity: DurableCallIdentity, wirePayloadHash: string, asks: DurableApprovalScope['asks'], commandId: string, now = Date.now()): PreparedDurableCall {
      for (const [key, entry] of prepared) if (entry.expiresAt <= now) prepared.delete(key);
      pruneRevocations(now);
      const base = {
        ...structuredClone(identity), machineId: identity.machineId.toLowerCase(), commandId,
        wirePayloadHash, scope: { context: '', asks: structuredClone(asks) },
      };
      base.scope.context = intentContext(base);
      if (!validIntent(base)) throw new DurableApprovalError('approval_changed', 'The canonical durable call is incomplete or invalid.');
      if ((!prepared.has(base.scope.context) && prepared.size >= PREPARED_MAX) || revoked.size >= DURABLE_APPROVAL_MAX_RECORDS + PREPARED_MAX) {
        throw new DurableApprovalError('approval_store_full', 'Too many calls are waiting for original approval or revocation expiry. No existing intent was discarded.');
      }
      prepared.set(base.scope.context, { intent: structuredClone(base), expiresAt: now + GRANT_REQUEST_TTL_MS });
      return structuredClone(base);
    },
    async approveAnsweredRequest(requestId: string, now = Date.now()): Promise<DurableApprovalReference> {
      await update((file) => {
        const answer = readAnsweredOriginal(requestId);
        const original = answer && prepared.get(answer.scope.context);
        if (!answer || answer.requestId !== requestId || !original || original.expiresAt <= now
          || answer.callerId !== original.intent.callerId || answer.callKey !== original.intent.callKey
          || deliveryHash(answer.scope) !== deliveryHash(original.intent.scope)) {
          throw new DurableApprovalError('approval_not_original', 'There is no original prepared call for this actual approval answer. Nothing was authorized.');
        }
        if (!finite(answer.expiresAt) || answer.expiresAt <= now || answer.expiresAt - now > GRANT_REQUEST_TTL_MS) {
          throw new DurableApprovalError('approval_expired', 'The original approval request has expired.');
        }
        if ((revoked.get(original.intent.scope.context) ?? 0) > now) throw new DurableApprovalError('approval_changed', 'The original command was revoked. Prepare a new command before asking again.');
        const previous = file.receipts.find((receipt) => receipt.requestId === requestId);
        if (previous) {
          if (previous.intent.scope.context !== original.intent.scope.context || previous.revoked) throw new DurableApprovalError('approval_changed', 'An answered request cannot authorize another call.');
          return;
        }
        file.receipts.push({ requestId, intent: structuredClone(original.intent), approvedAt: now, claimBy: answer.expiresAt });
      }, now);
      return { requestId };
    },
    async claim(reference: DurableApprovalReference, actual: PreparedDurableCall, freshGrant: 'allow' | 'ask' | 'refuse', now = Date.now()): Promise<DurableApprovalCheck> {
      if (freshGrant === 'refuse') return { allowed: false, reason: 'grant_refused' };
      let outcome: DurableApprovalCheck = { allowed: false, reason: 'approval_missing_or_invalid' };
      await update((file) => {
        outcome = check(reference, actual, freshGrant, now, false);
        if (outcome.allowed === false) return false;
        const receipt = file.receipts.find((entry) => entry.requestId === reference.requestId);
        if (!receipt) { outcome = { allowed: false, reason: 'approval_missing_or_invalid' }; return false; }
        if (receipt.boundAt !== undefined) return false;
        receipt.boundAt = now;
      }, now);
      return outcome;
    },
    verify(reference: unknown, actual: PreparedDurableCall, freshGrant: 'allow' | 'ask' | 'refuse', now = Date.now()): DurableApprovalCheck {
      return check(reference, actual, freshGrant, now, true);
    },
    findForCall(callKey: string, now = Date.now()): { reference: DurableApprovalReference; intent: PreparedDurableCall } | undefined {
      const receipt = get().receipts.find((entry) => entry.intent.callKey === callKey && !entry.revoked && (revoked.get(entry.intent.scope.context) ?? 0) <= now
        && now < (entry.boundAt === undefined ? entry.claimBy : entry.boundAt + DELIVERY_MAX_AGE_MS));
      return receipt && { reference: { requestId: receipt.requestId }, intent: structuredClone(receipt.intent) };
    },
    async revokeCaller(callerId: string, now = Date.now()): Promise<void> {
      pruneRevocations(now);
      for (const receipt of get().receipts) if (receipt.intent.callerId === callerId) {
        revokeIntent(receipt.intent.scope.context, receipt.boundAt === undefined ? receipt.claimBy : receipt.boundAt + DELIVERY_RETENTION_MS);
      }
      for (const [key, entry] of prepared) if (entry.intent.callerId === callerId) {
        revokeIntent(key, entry.expiresAt);
        prepared.delete(key);
      }
      await update((file) => {
        for (const receipt of file.receipts) if (receipt.intent.callerId === callerId) {
          revokeIntent(receipt.intent.scope.context, receipt.boundAt === undefined ? receipt.claimBy : receipt.boundAt + DELIVERY_RETENTION_MS);
          receipt.revoked = true;
        }
      }, now);
    },
  };
}
