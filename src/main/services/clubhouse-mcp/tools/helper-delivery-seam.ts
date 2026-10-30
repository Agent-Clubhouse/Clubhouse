/**
 * E2E seam (#2490): lets a chat spec send helper updates to a parent through
 * the real delivery path, deliverHelperUpdate, which message_parent and
 * Clubhouse's helper notices use. Spawning real helper agents would need a
 * second fake CLI per helper; this keeps the batching window, the runtime's
 * queue merging and the driver's send all real.
 *
 * Installed ONLY in unpackaged builds started with CLUBHOUSE_TEST_HELPER_SEAM=1,
 * like CLUBHOUSE_TEST_CLI_BINARIES. Specs call it from electronApp.evaluate as
 * `globalThis[HELPER_SEAM_GLOBAL](parentAgentId, text)`.
 */
import { app } from 'electron';
import { deliverHelperUpdate } from './helper-delivery';

export const HELPER_SEAM_GLOBAL = '__clubhouseTestDeliverHelperUpdate';

export function installHelperDeliverySeam(): void {
  if (app.isPackaged || process.env.CLUBHOUSE_TEST_HELPER_SEAM !== '1') return;
  (globalThis as Record<string, unknown>)[HELPER_SEAM_GLOBAL] = deliverHelperUpdate;
}
