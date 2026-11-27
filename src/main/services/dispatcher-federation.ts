/** Membership owns controller links. The pinned computer publishes its controller,
 * never its visible chat. Offline metadata is retained, but revocation wins on
 * every lookup, including attempts already waiting in durable delivery. */
import { DEFAULT_DISPATCHER_NAME, DISPATCHER_CONTROLLER_NAME } from '../../shared/dispatcher-name';
import { cleanDispatcherName } from '../../shared/dispatcher-personality';
import { formatAgentAddress } from '../../shared/agent-address';
import type { AgentAddress, ConnectionDirection } from '../../shared/connection-grants';
import { createSettingsStore, peekStoredSettingsSync } from './settings-store';
import { createHash } from 'crypto';
import type { DisplayInput, DisplayReceipt, DisplayValue } from './display-settings';
import { ownPairing } from './annex-network-membership';
import { listPeers } from './annex-peers';
import { onDevicesChanged } from './annex-device-signal';
import { dispatcherDisplayName, getDispatcherAgentId, getDispatcherState, isDispatcherEnabled, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { isPublishedDispatcherState, type PublishedDispatcherState } from '../../shared/dispatcher-presence';
import { FEDERATION_DISABLED_TOOLS, FEDERATION_SOURCE_ID, setFederationLookup, setFederationMessageLookup, setFederationStatus, type FederationPublicationGuard } from './dispatcher-federation-policy';
import type { PersistedBindingSource } from './persisted-bindings';

export interface FederationController {
  agentId: string | null;
  /** Legacy tool-addressing name. Never changes on a rename. */
  name: string;
  /** User-facing name, absent on older computers. */
  displayName?: string;
  enabled: boolean;
  /** Whether it is working or asleep, for presence (#3349). Older computers don't send it. */
  state?: PublishedDispatcherState;
  pairingId?: string;
  ownPairingId?: string;
}
const controllers = createSettingsStore<{ controllers: Record<string, FederationController> }>(
  'dispatcher-federation.json', { controllers: {} }, undefined,
  { atomic: true, audit: { key: 'dispatcher_federation' } },
);
const listeners = new Set<() => void>();
export function federationDisplayName(info: FederationController): string {
  const name = info.displayName ?? (info.name === DISPATCHER_CONTROLLER_NAME ? DEFAULT_DISPATCHER_NAME : info.name);
  return cleanDispatcherName(name) || DEFAULT_DISPATCHER_NAME;
}

export function localFederationController(): FederationController {
  const enabled = isDispatcherEnabled();
  return { agentId: getDispatcherAgentId(), name: DISPATCHER_CONTROLLER_NAME, displayName: dispatcherDisplayName(), enabled, ...(enabled && { state: localDispatcherState() }) };
}

/** As the Dispatcher's own badge judges it: asleep while its agent isn't running, working while requests are under way. */
function localDispatcherState(): PublishedDispatcherState {
  const state = getDispatcherState();
  if (!state.workRunning) return 'asleep';
  return state.requestsUnderWay > 0 ? 'working' : 'online';
}

/** Hear when a computer's published controller changes. */
export function onFederationControllersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function remoteFederationController(machine: string): FederationController | undefined {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  const saved = controllers.get().controllers[machine.toLowerCase()];
  if (!peer || !saved || saved.pairingId !== peer.pairingId || (saved.ownPairingId ?? 'legacy') !== (ownPairing()?.id ?? 'legacy')) return undefined;
  return { ...saved, displayName: typeof saved.displayName === 'string' ? cleanDispatcherName(saved.displayName) || DEFAULT_DISPATCHER_NAME : undefined };

}
/** Recorded selected publication fields, not proof of current transport or authority. */
export interface FederationControllerDisplay {
  agentId: DisplayValue<string | null>;
  name: DisplayValue<string>;
  enabled: DisplayValue<boolean>;
  presence: DisplayValue<PublishedDispatcherState>;
  association: 'matched-retained' | 'mismatch' | 'unavailable';
}
interface ControllerDisplayFrame {
  value: DisplayValue<Omit<FederationControllerDisplay, 'association'>>;
  own?: string;
  peer?: string;
  key: string;
}
const controllerRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function controllerDisplayFrame(machine: string): ControllerDisplayFrame {
  // No yield/callback between guard/get. Every receipt read repeats this guard;
  // cold metadata uses the bounded fixed primary peek without recovery/defaults.
  const loaded = controllers.hasLoaded?.() === true;
  const raw: unknown = loaded ? controllers.get() : peekStoredSettingsSync('dispatcher-federation.json', { maxBytes: 256 * 1024 });
  const inputs: DisplayInput[] = [{ field: 'Recorded selected Dispatcher publication', source: loaded ? 'host-cache' : 'primary', observedAt: Date.now() }];
  const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
  const unknown = <T>(): DisplayValue<T> => ({ state: 'unavailable', inputs });
  const unavailable = (): ControllerDisplayFrame => ({ value: unknown(), key: 'unavailable' });
  if (!controllerRecord(raw) || !controllerRecord(raw.controllers)) return unavailable();
  const key = machine.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(raw.controllers, key)) return unavailable();
  const saved = raw.controllers[key]; if (!controllerRecord(saved)) return unavailable();
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 200;
  const identifier = (v: unknown): v is string => text(v) && !!v && !v.includes('@');
  const pairing = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^[A-Za-z0-9-]{8,64}$/.test(v);
  const name = text(saved.displayName) ? known(cleanDispatcherName(saved.displayName) || DEFAULT_DISPATCHER_NAME)
    : saved.displayName !== undefined || !text(saved.name) ? unknown<string>()
    : known(cleanDispatcherName(saved.name === DISPATCHER_CONTROLLER_NAME ? DEFAULT_DISPATCHER_NAME : saved.name) || DEFAULT_DISPATCHER_NAME);
  const value = known({
    agentId: saved.agentId === null || identifier(saved.agentId) ? known(saved.agentId as string | null) : unknown<string | null>(),
    name,
    enabled: typeof saved.enabled === 'boolean' ? known(saved.enabled) : unknown<boolean>(),
    presence: isPublishedDispatcherState(saved.state) ? known(saved.state) : unknown<PublishedDispatcherState>(),
  });
  const own = pairing(saved.ownPairingId) ? saved.ownPairingId : undefined, peer = pairing(saved.pairingId) ? saved.pairingId : undefined;
  // Selected bounded safe fields plus bounded association scalars only. Do not
  // retain raw roots/records/unrelated publications, or infer legacy epochs.
  const signature = JSON.stringify({ value, own, peer }, (k, v) => k === 'inputs' ? undefined : v);
  return { value, own, peer, key: createHash('sha256').update(signature).digest('hex') };
}
function controllerDisplayReceipt(machine: string, key: string): DisplayReceipt {
  return { current: () => { try { return controllerDisplayFrame(machine).key === key; } catch { return false; } } };
}
/** Both matchers are private display observations captured with their OWN
 * receipts by the consumer. They never replace the independent eligible pinned
 * transport, role, revocation, selected-target or request-router checks. */
export function readFederationControllerForDisplay(machine: string, options: {
  own: { matches(reference: unknown): boolean | undefined };
  peer: { matches(reference: unknown): boolean | undefined };
  receipts: DisplayReceipt[];
}): DisplayValue<FederationControllerDisplay> {
  if (typeof machine !== 'string' || !machine || machine.length > 256) return { state: 'unavailable', reason: 'invalid', inputs: [{ field: 'Selected Dispatcher publication', source: 'primary', observedAt: Date.now() }] };
  const frame = controllerDisplayFrame(machine), receipt = controllerDisplayReceipt(machine, frame.key); options.receipts.push(receipt);
  if (frame.value.state !== 'ok') return frame.value;
  let association: FederationControllerDisplay['association'] = 'unavailable';
  if (frame.own !== undefined && frame.peer !== undefined) {
    const own = options.own.matches(frame.own), peer = options.peer.matches(frame.peer);
    association = own === false || peer === false ? 'mismatch' : own === true && peer === true ? 'matched-retained' : 'unavailable';
  }
  if (!receipt.current()) return { state: 'unavailable', reason: 'changed', inputs: frame.value.inputs };
  return { ...frame.value, value: { ...frame.value.value, association } };
}

export async function learnFederationController(machine: string, raw: unknown, publication?: FederationPublicationGuard): Promise<void> {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  if (!peer) return;
  const pairing = publication?.epoch.receiver ?? peer.pairingId ?? 'legacy';
  const selfPairing = publication?.epoch.sender ?? ownPairing()?.id ?? 'legacy';
  const current = () => (!publication || publication.current()) && (ownPairing()?.id ?? 'legacy') === selfPairing && listPeers().some((p) => p.fingerprint.toLowerCase() === machine.toLowerCase()
    && p.role === 'member' && p.kind !== 'phone' && (p.pairingId ?? 'legacy') === pairing);
  if (!current()) return;
  const value = raw as FederationController | null;
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean'
    || typeof value.name !== 'string' || !value.name || value.name.length > 200
    || (value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.length > 200))
    || (value.agentId !== null && (typeof value.agentId !== 'string' || !value.agentId || value.agentId.length > 200 || value.agentId.includes('@')))
    || (value.state !== undefined && !isPublishedDispatcherState(value.state))) return;
  const info = { agentId: value.agentId, name: value.name, ...(value.displayName !== undefined && { displayName: cleanDispatcherName(value.displayName) || DEFAULT_DISPATCHER_NAME }), enabled: value.enabled, ...(value.state && { state: value.state }),
    ownPairingId: selfPairing, ...(peer.pairingId && { pairingId: peer.pairingId }) };
  if (JSON.stringify(remoteFederationController(machine)) === JSON.stringify(info)) return;
  const stale = new Error('Controller publication belongs to an earlier network pairing or service.');
  try {
    await controllers.update((file) => {
      const members = new Set(listPeers().filter((p) => p.role === 'member' && p.kind !== 'phone').map((p) => p.fingerprint.toLowerCase()));
      return { controllers: { ...Object.fromEntries(Object.entries(file.controllers).filter(([id]) => members.has(id))), [machine.toLowerCase()]: info } };
    }, { prepare: async () => {}, check: () => { if (!current()) throw stale; } });
  } catch (err) {
    if (err === stale) return;
    throw err;
  }
  if (!current()) return;
  for (const listener of listeners) listener();
}

/** The receiving computer's own copy, derived from its own membership. */
export function controllerDirection(from: AgentAddress, to: AgentAddress): ConnectionDirection | undefined {
  if (!!from.machineId === !!to.machineId) return undefined;
  const remote = from.machineId ? from : to;
  const local = from.machineId ? to : from;
  if (local.agentId !== getDispatcherAgentId()) return undefined;
  const machine = remote.machineId!.toLowerCase();
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine && p.role === 'member' && p.kind !== 'phone');
  if (!peer) return undefined;
  if (remoteFederationController(machine)?.agentId !== remote.agentId) return undefined;
  const joinedAt = peer.pairedAt || new Date(0).toISOString();
  return { from, to, disabledTools: [...FEDERATION_DISABLED_TOOLS], link: { createdAt: joinedAt }, updatedAt: joinedAt };
}

export const federationBindingSource: PersistedBindingSource = {
  id: FEDERATION_SOURCE_ID, prune: true, readOnlyCollect: true,
  async collect() {
    const local = localFederationController();
    if (!local.agentId || !local.enabled) return [];
    return listPeers().flatMap((peer) => {
      if (peer.role !== 'member' || peer.kind === 'phone') return [];
      const remote = remoteFederationController(peer.fingerprint);
      if (!remote?.agentId) return [];
      const address = formatAgentAddress({ agentId: remote.agentId, machine: peer.fingerprint.toLowerCase() });
      return [{ agentId: local.agentId!, targetId: address,
        targetKind: 'agent' as const, label: `${federationDisplayName(remote)} on ${peer.alias}`, agentName: federationDisplayName(local),
        targetName: remote.name, projectName: peer.alias, disabledTools: [...FEDERATION_DISABLED_TOOLS], enabledTools: [] as string[], startingTools: true as const }, {
          agentId: address, targetId: local.agentId!, targetKind: 'agent' as const,
          label: federationDisplayName(local), agentName: federationDisplayName(remote), targetName: local.name, projectName: peer.alias,
          disabledTools: [...FEDERATION_DISABLED_TOOLS], enabledTools: [] as string[], startingTools: true as const,
        }];
    });
  },
};

export function watchFederation(changed: () => void, connected: (machine: string) => boolean = () => true): () => void {
  const offLookup = setFederationLookup(controllerDirection);
  const offMessages = setFederationMessageLookup((from, to) => {
    if (!!from.machineId === !!to.machineId) return;
    const remote = from.machineId ? from : to;
    const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === remote.machineId!.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
    if (!peer) return;
    const published = remoteFederationController(remote.machineId!);
    // Outgoing direct news must target the published controller, never another remote agent.
    if (!from.machineId && (!published?.agentId || !published.enabled || to.agentId !== published.agentId)) return;
    // Incoming direct news must target our hidden controller, never the visible chat.
    if (from.machineId && to.agentId !== getDispatcherAgentId()) return;
    const at = peer.pairedAt || new Date(0).toISOString();
    return { from, to, link: { createdAt: at }, updatedAt: at, disabledTools: [...FEDERATION_DISABLED_TOOLS] };
  });
  const offStatus = setFederationStatus((from, to) => {
    if (!controllerDirection(from, to)) return undefined;
    const remote = from.machineId ? from : to;
    if (!isDispatcherEnabled()) return { state: 'unavailable', reason: 'This Dispatcher is off. Controller connections are unavailable.' };
    if (!remoteFederationController(remote.machineId!)?.enabled) return { state: 'unavailable', reason: 'The other Dispatcher is off. Controller connections are unavailable.' };
    if (!connected(remote.machineId!)) return { state: 'paused', reason: 'The other computer is offline. Controller connections are paused until it reconnects.' };
    return undefined;
  });
  listeners.add(changed);
  // Authenticated sync traffic refreshes lastSeen too. Echoing that refresh
  // would make idle peers continually resync and rebuild each other.
  const offDevices = onDevicesChanged((change) => {
    if (change !== 'last-seen') changed();
  });
  const offDispatcher = onDispatcherChanged(changed);
  return () => { offLookup(); offMessages(); offStatus(); listeners.delete(changed); offDevices(); offDispatcher(); };
}
