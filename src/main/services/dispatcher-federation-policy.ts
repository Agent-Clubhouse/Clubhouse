import type { AnnexDeliveryEpoch } from '../../shared/annex-delivery';
import type { AgentAddress, ConnectionDirection } from '../../shared/connection-grants';

export const FEDERATION_SOURCE_ID = 'dispatcher-federation';
export const FEDERATION_TOOLS = new Set(['get_status', 'check_connectivity', 'send_message', 'send_file', 'hand_off_request']);
export const FEDERATION_DISABLED_TOOLS = ['read_output', 'clear_agent', 'compact_agent', 'wake_agent'];
export const FEDERATION_READ_ONLY = 'This controller connection follows Annex Network membership. Its tools cannot be changed.';

type Lookup = (from: AgentAddress, to: AgentAddress) => ConnectionDirection | undefined;
let lookup: Lookup = () => undefined;
export function setFederationLookup(value: Lookup): () => void {
  lookup = value;
  return () => { if (lookup === value) lookup = () => undefined; };
}
export function federationDirection(from: AgentAddress, to: AgentAddress): ConnectionDirection | undefined {
  return lookup(from, to);
}
export function assertEditableConnection(from: AgentAddress, to: AgentAddress): void {
  if (federationDirection(from, to)) throw new Error(FEDERATION_READ_ONLY);
}

export interface FederationStatus { state: 'paused' | 'unavailable'; reason: string }
let status: (from: AgentAddress, to: AgentAddress) => FederationStatus | undefined = () => undefined;
export function federationStatus(from: AgentAddress, to: AgentAddress): FederationStatus | undefined { return status(from, to); }
export function setFederationStatus(value: typeof status): () => void {
  status = value;
  return () => { if (status === value) status = () => undefined; };
}

/** Captured before authenticated I/O. Checked again at the metadata commit. */
export interface FederationPublicationGuard {
  epoch: AnnexDeliveryEpoch;
  current(): boolean;
}
