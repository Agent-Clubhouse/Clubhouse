import { parseNamespacedId } from '../../../stores/remoteProjectStore';

/** A remote project flag alone cannot supply an agent's host or target identity. */
export function remoteDetailsAddress(id: string) {
  const address = parseNamespacedId(id);
  return address?.satelliteId && address.agentId && address.agentId.length <= 240 ? address : null;
}
