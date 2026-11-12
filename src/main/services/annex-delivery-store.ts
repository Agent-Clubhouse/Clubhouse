import { createHash } from 'crypto';
import type { AnnexCallContext, AnnexDeliveryEpoch, AnnexDeliveryFailure, AnnexDeliveryReceipt, AnnexDeliveryStatus, AnnexDeliveryProtocolName } from '../../shared/annex-delivery';
import type { McpToolResult } from './clubhouse-mcp/types';
import { createSettingsStore } from './settings-store';
import {
  annexProtocolWireHash, snapshotAnnexProtocolContext, snapshotAnnexProtocolEnvelope, type AnnexProtocolLocalContext,
} from './annex-delivery-protocols';

export const DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const DELIVERY_RETENTION_MS = DELIVERY_MAX_AGE_MS + 24 * 60 * 60_000;
export const DELIVERY_MAX_RECORDS = 10_000;
export const DELIVERY_MAX_BYTES = 64 * 1024 * 1024;
export const DELIVERY_MAX_RESULT_BYTES = 64 * 1024;

export interface DurableAgentCall {
  v: number;
  callId: string;
  from: { agentId: string; name: string; projectName?: string };
  to: string;
  tool: string;
  args: Record<string, unknown>;
  context?: AnnexCallContext;
  epoch?: AnnexDeliveryEpoch;
  protocol?: AnnexDeliveryProtocolName;
  commandId?: string;
}

export interface DeliveryOutboxItem {
  id: string;
  machine: string;
  body: DurableAgentCall;
  queuedAt: string;
  protocolContext?: AnnexProtocolLocalContext;
}

export interface SenderDelivery extends AnnexDeliveryStatus {
  payloadHash: string;
  result?: McpToolResult;
  failureNotified?: boolean;
}

export interface ReceiverDelivery {
  key: string;
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
  state: 'claimed' | AnnexDeliveryReceipt['state'];
  reason?: string;
  result?: McpToolResult;
}

export interface DeliveryFile {
  version: 1;
  outbox: DeliveryOutboxItem[];
  inbox: ReceiverDelivery[];
  deliveries: SenderDelivery[];
}

const empty = (): DeliveryFile => ({ version: 1, outbox: [], inbox: [], deliveries: [] });

function validateProtocolOutbox(file: DeliveryFile): void {
  for (const item of file.outbox) {
    if (item.body.protocol === undefined && item.protocolContext === undefined) continue;
    const body = snapshotAnnexProtocolEnvelope(item.body);
    if (JSON.stringify(item.body) !== JSON.stringify(body)) throw new Error('The stored Annex protocol body is not the exact prepared wire encoding.');
    snapshotAnnexProtocolContext(item.protocolContext);
    if (file.deliveries.find((row) => row.callId === item.id)?.payloadHash !== annexProtocolWireHash(body)) {
      throw new Error('The persisted Annex protocol envelope does not match its full-wire hash.');
    }
  }
}

/** Stable hashes also reject a reused id whose arguments changed key order only. */
export function deliveryHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function boundedDeliveryResult(result: McpToolResult): McpToolResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= DELIVERY_MAX_RESULT_BYTES) return result;
  return {
    content: [{ type: 'text', text: 'The receiving tool returned an answer too large to retain. Query the target separately for its output; this receipt does not prove model execution.' }],
    ...(result.isError && { isError: true }),
  };
}

export class DeliveryStoreError extends Error {
  constructor(public readonly code: 'delivery_store_unreadable' | 'delivery_store_full', message: string) { super(message); }
}

export interface AnnexDeliveryStore {
  get(): DeliveryFile;
  update(change: (file: DeliveryFile) => void, now?: number): Promise<void>;
  clearForTesting(): Promise<void>;
}

/**
 * Never evict a live dedupe record to make room: refuse new work instead.
 * The committed snapshot is published only after the atomic write resolves.
 */
export function createAnnexDeliveryStore(filename = 'annex-agent-outbox.json'): AnnexDeliveryStore {
  let loadError: unknown;
  const store = createSettingsStore<DeliveryFile>(filename, empty(), (raw) => {
    if (raw.version === 1 && Array.isArray(raw.items)) {
      const outbox = raw.items as DeliveryOutboxItem[];
      raw = {
        version: 1, outbox, inbox: [],
        deliveries: outbox.map((item): SenderDelivery => ({
          callId: item.id, callerId: item.body.from.agentId, targetId: `${item.body.to}@${item.machine}`, tool: item.body.tool,
          state: 'queued', queuedAt: item.queuedAt, updatedAt: item.queuedAt, attempts: 0,
          payloadHash: deliveryHash({ from: item.body.from.agentId, to: item.body.to, tool: item.body.tool, args: item.body.args }),
        })),
      };
    }
    if (raw.version !== 1 || !Array.isArray(raw.outbox) || !Array.isArray(raw.inbox) || !Array.isArray(raw.deliveries)) throw new Error('Invalid delivery store');
    const file = raw as unknown as DeliveryFile;
    if (file.inbox.some((r) => !r || typeof r.key !== 'string' || typeof r.payloadHash !== 'string' || !Number.isFinite(Date.parse(r.updatedAt)) || !['claimed', 'delivered', 'refused', 'retry_later', 'indeterminate'].includes(r.state))
      || file.deliveries.some((r) => !r || typeof r.callId !== 'string' || typeof r.payloadHash !== 'string' || !Number.isFinite(Date.parse(r.updatedAt)))
      || file.outbox.some((r) => !r || typeof r.id !== 'string' || !r.body || r.body.callId !== r.id || typeof r.machine !== 'string' || !Number.isFinite(Date.parse(r.queuedAt)))) throw new Error('Invalid delivery records');
    validateProtocolOutbox(file);
    return file;
  }, {
    atomic: true, mode: 0o600, rollBackFailedSaves: true,
    onLoad: (result) => {
      if ('error' in result && (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT') loadError = result.error;
      if ('raw' in result) {
        const parsed: unknown = JSON.parse(result.raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          loadError = new Error('Invalid delivery store root');
          return;
        }
        const raw = parsed as Record<string, unknown>;
        if (Buffer.byteLength(result.raw) > DELIVERY_MAX_BYTES || raw.version !== 1
          || (!Array.isArray(raw.items) && (!Array.isArray(raw.outbox) || !Array.isArray(raw.inbox) || !Array.isArray(raw.deliveries)))) {
          loadError = new Error('Incomplete delivery store');
        }
      }
    },
  });
  let committed: DeliveryFile | undefined;
  let lock: Promise<void> = Promise.resolve();
  const get = (): DeliveryFile => {
    if (!committed) {
      const loaded = store.get();
      if (loadError) throw new DeliveryStoreError('delivery_store_unreadable', 'The durable delivery store is unreadable. No calls were run; repair or restore the store before retrying.');
      committed = structuredClone(loaded);
    }
    return structuredClone(committed);
  };
  return {
    get,
    update(change, now = Date.now()) {
      const task = lock.catch(() => {}).then(async () => {
        const file = get();
        const waiting = new Set(file.outbox.map((i) => i.id));
        file.inbox = file.inbox.filter((r) => now - Date.parse(r.updatedAt) < DELIVERY_RETENTION_MS);
        file.deliveries = file.deliveries.filter((r) => waiting.has(r.callId) || r.failureNotified === false || now - Date.parse(r.updatedAt) < DELIVERY_RETENTION_MS);
        change(file);
        validateProtocolOutbox(file);
        // Reserve space for each in-flight outcome, so accepting a call cannot
        // consume the capacity needed to durably finish an earlier one.
        const reserved = file.inbox.filter((r) => r.state === 'claimed').length * DELIVERY_MAX_RESULT_BYTES;
        // Match settings-store's on-disk encoding, not its smaller compact form.
        if (file.inbox.length + file.deliveries.length > DELIVERY_MAX_RECORDS || Buffer.byteLength(JSON.stringify(file, null, 2)) + reserved > DELIVERY_MAX_BYTES) {
          throw new DeliveryStoreError('delivery_store_full', 'The durable delivery store is full. Existing receipts are retained; retry after they expire.');
        }
        await store.save(file);
        committed = structuredClone(file);
      });
      lock = task;
      return task;
    },
    async clearForTesting() {
      await lock.catch(() => {});
      await store.save(empty());
      committed = empty();
      loadError = undefined;
    },
  };
}

export function deliveryFailure(status: SenderDelivery): AnnexDeliveryFailure | undefined {
  if (status.state !== 'refused' && status.state !== 'expired' && status.state !== 'indeterminate') return undefined;
  const { callId, callerId, targetId, tool, state, queuedAt, updatedAt, attempts, reason } = status;
  return { callId, callerId, targetId, tool, state, queuedAt, updatedAt, attempts, ...(reason && { reason }) };
}
