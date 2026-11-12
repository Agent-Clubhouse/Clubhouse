import { DISPATCHER_FEDERATION_TOOLS, type DispatcherFederationPeer } from '../../../shared/dispatcher-federation';
import { formatAgentAddress, parseAgentAddress } from '../../../shared/agent-address';
import { appLog } from '../log-service';

let peers: DispatcherFederationPeer[] = [];
let localControllerId: string | null = null;
let policyVersion = 0;
const listeners = new Set<() => void>();

export function getDispatcherFederationPeers(): DispatcherFederationPeer[] {
  return peers.map((peer) => ({ ...peer }));
}

/** Existing Annex link events supply this snapshot; there is no federation polling loop. */
export function setDispatcherFederationPeers(next: readonly DispatcherFederationPeer[]): void {
  if (JSON.stringify(peers) === JSON.stringify(next)) return;
  peers = next.map((peer) => ({ ...peer }));
  policyVersion++;
  for (const listener of listeners) {
    try { listener(); } catch (error) {
      // telemetry-exempt: logged; one subscriber cannot hide presence from the others.
      appLog('core:dispatcher', 'warn', 'Dispatcher federation presence subscriber failed', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

export function onDispatcherFederationPeersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setDispatcherFederationControllerId(id: string | null): void {
  if (localControllerId !== id) policyVersion++;
  localControllerId = id;
}

export function dispatcherFederationPolicyVersion(): number {
  return policyVersion;
}

export function remoteDispatcherFederationPeer(address: string): DispatcherFederationPeer | undefined {
  const parsed = parseAgentAddress(address);
  if (!parsed.machine) return undefined;
  const qualified = formatAgentAddress(parsed);
  const peer = peers.find((entry) => entry.address === qualified);
  return peer && { ...peer };
}

export function remoteDispatcherFederationMachine(name: string): DispatcherFederationPeer | undefined {
  const matches = peers.filter((peer) => peer.address && peer.machineName.trim().toLowerCase() === name.trim().toLowerCase());
  return matches.length === 1 ? { ...matches[0] } : undefined;
}

/** Source ownership, independent of editable connection switches and current availability. */
export function fixedDispatcherFederationTools(fromId: string, targetId: string): readonly string[] | undefined {
  return localControllerId && ((fromId === localControllerId && remoteDispatcherFederationPeer(targetId))
    || (targetId === localControllerId && remoteDispatcherFederationPeer(fromId)))
    ? DISPATCHER_FEDERATION_TOOLS : undefined;
}
