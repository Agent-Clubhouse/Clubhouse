import { createHash } from 'crypto';
import { canonicalHandoffManifest, parseHandoffManifest, summarizeHandoffManifest, type HandoffTransferBounds } from '../../shared/handoff-manifest';
import { HANDOFF_TRANSFER_ROUTE, HANDOFF_TRANSFER_TIMEOUT_MS, HANDOFF_TRANSFER_BODY_BYTES, HandoffTransferBusy, type HandoffTransferRequest } from '../../shared/handoff-transfer';
import type { Handoff } from '../../shared/handoffs';
import { getOrCreateIdentity } from './annex-identity';
import { postToMachine } from './annex-client';
import { HandoffTransferInterrupted, HandoffTransferRefused } from './handoff-transfer-receiver';
import { HandoffSnapshotError } from './handoff-snapshot';

/** Local transfers use the identical authorization/content boundary without an HTTP round trip. */
export async function requestHandoffTransfer(record: Handoff, request: HandoffTransferRequest): Promise<unknown> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new HandoffTransferInterrupted()); }, HANDOFF_TRANSFER_TIMEOUT_MS);
  });
  try {
    const work = async () => {
      if (record.from.machine === getOrCreateIdentity().fingerprint.toLowerCase()) {
        try { return await (await import('./handoff-host')).receiveHandoffTransfer(record.to.machine, request); }
        catch (error) {
          if (error instanceof HandoffTransferBusy) throw new HandoffTransferInterrupted();
          throw new HandoffTransferRefused(); // Local admission/verification failures match the HTTP 400 boundary.
        }
      }
      const response = await postToMachine(record.from.machine, HANDOFF_TRANSFER_ROUTE, request, { signal: controller.signal, maxResponseBytes: HANDOFF_TRANSFER_BODY_BYTES });
      if ([400, 403, 404].includes(response.status)) throw new HandoffTransferRefused();
      if (response.status !== 200) throw new HandoffTransferInterrupted();
      return response.body;
    };
    return await Promise.race([work(), expired]);
  } catch (error) {
    if (error instanceof HandoffTransferRefused) throw error;
    throw new HandoffTransferInterrupted();
  } finally { if (timer) clearTimeout(timer); }
}

/** Offered metadata is available before acceptance so a Dispatcher can choose a registered project. */
export async function readHandoffTransferManifest(record: Handoff, bounds: HandoffTransferBounds = { totalBytes: 16 * 1024 ** 3, perFileBytes: 16 * 1024 ** 3, maxFiles: 10_000 }) {
  if (!record.manifest) throw new Error('This handoff must be prepared and offered again.');
  const raw = await requestHandoffTransfer(record, { op: 'manifest', id: record.id });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !('manifest' in raw)) throw new HandoffSnapshotError('hash_mismatch');
  const manifest = parseHandoffManifest(raw.manifest, bounds); const summary = summarizeHandoffManifest(manifest);
  if (summary.sha256 !== record.manifest.sha256 || summary.totalBytes !== record.manifest.totalBytes || summary.fileCount !== record.manifest.fileCount
    || createHash('sha256').update(canonicalHandoffManifest(manifest, bounds)).digest('hex') !== summary.sha256) throw new HandoffSnapshotError('hash_mismatch');
  return manifest;
}
