import { isRemoteAgentDetails, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails } from './remote-agent-details';

/** Explicit same-host role binding from the desktop-only role Details GET. */
export interface SelectedDispatcherDetails {
  version: 1;
  role: 'dispatcher';
  agentId: string;
  details: RemoteAgentDetails;
}

/** Only a whole matching role response, never an inventory/source page or private receipt. */
export function isSelectedDispatcherDetails(value: unknown): value is SelectedDispatcherDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SelectedDispatcherDetails;
  if (!Object.keys(v).every((key) => ['version', 'role', 'agentId', 'details'].includes(key))
    || v.version !== 1 || v.role !== 'dispatcher' || typeof v.agentId !== 'string' || !v.agentId || v.agentId.length > 2048
    || !isRemoteAgentDetails(v.details, v.agentId) || v.details.connectionPageOnly === true || v.details.helperPageOnly === true
    || ('inventoryPageOnly' in v.details && v.details.inventoryPageOnly === true)) return false;
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= REMOTE_DETAILS_MAX_BYTES; }
  catch { return false; /* telemetry-exempt: malformed remote envelopes are unavailable, never partially admitted. */ }
}
