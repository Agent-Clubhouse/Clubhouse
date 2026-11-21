/** Host-only composition for the explicit desktop Details adapter; never a snapshot or client/UI lookup. */
import { isRemoteAgentDetails, REMOTE_DETAILS_MAX_BYTES } from '../../shared/remote-agent-details';
import type { DisplayReceipt } from './display-settings';
import { dispatcherControllerForDisplay } from './remote-dispatcher-card';
import { readRemoteAgentDetails } from './remote-agent-details';

import { isSelectedDispatcherConnectionPage, isSelectedDispatcherConnectionsQuery, type SelectedDispatcherConnectionsQuery, type SelectedDispatcherDetails } from '../../shared/selected-dispatcher-details';
export type { SelectedDispatcherDetails } from '../../shared/selected-dispatcher-details';

/**
 * The pinned desktop adapter must supply the SAME desktopDetailsAuthorized
 * callback as ordinary agent Details, before and after this call. No caller-
 * supplied id, address, role, path or controller/mobile grant is accepted here.
 * An optional Connections page query pages the same host-selected role only.
 */
export async function readSelectedDispatcherDetails(authorized?: () => boolean, query?: SelectedDispatcherConnectionsQuery): Promise<{ status: number; body: unknown; receipt?: DisplayReceipt }> {
  const allowed = authorized ?? (() => false);
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  const changed = () => ({ status: 409, body: { error: 'dispatcher_role_changed' } });
  if (!allowed()) return refused();
  if (query !== undefined && !isSelectedDispatcherConnectionsQuery(query)) return { status: 400, body: { error: 'invalid_dispatcher_details_query' } };
  const receipts: DisplayReceipt[] = [];
  const current = () => receipts.every((receipt) => receipt.current());
  try {
    // Existing passive canonical admission: cached role id, exact strict primary,
    // canonical folder and final primary/role witnesses, including while off.
    const target = await dispatcherControllerForDisplay({ receipts, authorized: allowed })();
    if (!allowed()) return refused();
    if (!current()) return changed();
    // Unbound/unreadable is unavailable, not verified never-created or asleep.
    if (!target) return { status: 404, body: { error: 'dispatcher_role_unavailable' } };
    const result = query ? await readRemoteAgentDetails(target.agent.id, allowed, { ...query }) : await readRemoteAgentDetails(target.agent.id, allowed);
    if (!allowed()) return refused();
    if (!current()) return changed();
    if (result.status !== 200) return result;
    if (!isRemoteAgentDetails(result.body, target.agent.id)) return { status: 500, body: { error: 'dispatcher_details_invalid' } };
    const body: SelectedDispatcherDetails = { version: 1, role: 'dispatcher', agentId: target.agent.id, details: result.body };
    if (query ? !isSelectedDispatcherConnectionPage(body, query) : result.body.connectionPageOnly === true
      || ('helperPageOnly' in result.body && result.body.helperPageOnly === true)
      || ('inventoryPageOnly' in result.body && result.body.inventoryPageOnly === true)) {
      return { status: 500, body: { error: 'dispatcher_details_invalid' } };
    }
    if (Buffer.byteLength(JSON.stringify(body)) > REMOTE_DETAILS_MAX_BYTES) {
      return { status: 500, body: { error: 'dispatcher_details_limit' } };
    }
    if (!allowed()) return refused();
    if (!current()) return changed();
    // Internal-only final receipt: the HTTP adapter must recheck this after its await and serialize body only.
    return { status: 200, body, receipt: { current } };
  } catch {
    // telemetry-exempt: staged read returns bounded status, never raw host errors or partial private evidence.
    return allowed() ? { status: 500, body: { error: 'dispatcher_details_failed' } } : refused();
  }
}
