export class HandoffTransferBusy extends Error { constructor() { super('Handoff transfer busy.'); } }
export const HANDOFF_CHUNK_BYTES = 256 * 1024;
export const HANDOFF_TRANSFER_BODY_BYTES = 3 * 1024 ** 2;
export const HANDOFF_TRANSFER_ROUTE = '/api/v1/network/handoffs/transfer';
export const HANDOFF_TRANSFER_TIMEOUT_MS = 120_000;
export type HandoffTransferRequest = { op: 'manifest'; id: string } | { op: 'read'; id: string; file: number; offset: number };
export function parseHandoffTransferRequest(raw: unknown): HandoffTransferRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff transfer request.');
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)) throw new Error('Invalid handoff transfer id.');
  if (value.op === 'manifest' && Object.keys(value).every((key) => ['op', 'id'].includes(key))) return { op: 'manifest', id: value.id };
  if (value.op === 'read' && Object.keys(value).every((key) => ['op', 'id', 'file', 'offset'].includes(key))
    && Number.isSafeInteger(value.file) && (value.file as number) >= -1 && (value.file as number) < 10_000
    && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && (value.offset as number) <= 16 * 1024 ** 3) return { op: 'read', id: value.id, file: value.file as number, offset: value.offset as number };
  throw new Error('Invalid handoff transfer operation.');
}
