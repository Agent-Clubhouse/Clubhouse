/** Staged host-only composition. No route, IPC API or snapshot producer invokes it yet. */
import { isRemoteAgentDetails, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails } from '../../shared/remote-agent-details';
import type { DisplayReceipt } from './display-settings';
import { dispatcherControllerForDisplay } from './remote-dispatcher-card';
import { readRemoteAgentDetails } from './remote-agent-details';

/** Safe role binding plus the ordinary Details projection; never an Agent/config/receipt export. */
export interface SelectedDispatcherDetails {
  version: 1;
  role: 'dispatcher';
  agentId: string;
  details: RemoteAgentDetails;
}

/**
 * The future pinned desktop adapter must supply the SAME desktopDetailsAuthorized
 * callback as ordinary agent Details, before and after this call. No caller-
 * supplied id, address, role, path or controller/mobile grant is accepted here.
 */
export async function readSelectedDispatcherDetails(authorized?: () => boolean): Promise<{ status: number; body: unknown }> {
  const allowed = authorized ?? (() => false);
  const refused = () => ({ status: 403, body: { error: 'details_read_refused' } });
  const changed = () => ({ status: 409, body: { error: 'dispatcher_role_changed' } });
  if (!allowed()) return refused();
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
    const result = await readRemoteAgentDetails(target.agent.id, allowed);
    if (!allowed()) return refused();
    if (!current()) return changed();
    if (result.status !== 200) return result;
    if (!isRemoteAgentDetails(result.body, target.agent.id) || result.body.connectionPageOnly === true) {
      return { status: 500, body: { error: 'dispatcher_details_invalid' } };
    }
    const body: SelectedDispatcherDetails = { version: 1, role: 'dispatcher', agentId: target.agent.id, details: result.body };
    if (Buffer.byteLength(JSON.stringify(body)) > REMOTE_DETAILS_MAX_BYTES) {
      return { status: 500, body: { error: 'dispatcher_details_limit' } };
    }
    if (!allowed()) return refused();
    if (!current()) return changed();
    return { status: 200, body };
  } catch {
    // telemetry-exempt: staged read returns bounded status, never raw host errors or partial private evidence.
    return allowed() ? { status: 500, body: { error: 'dispatcher_details_failed' } } : refused();
  }
}
