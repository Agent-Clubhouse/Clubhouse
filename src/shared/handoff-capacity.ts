import { isMachineFingerprint } from './agent-address';
import { CAPACITY_WIRE_ORDER, providerIdsWhere, type CapacityProviderId } from './providers/descriptors';

/** Descriptors with `capacityTracked`: what this machine samples and reports to peers that agreed to them. */
export const CAPACITY_PROVIDERS: readonly CapacityProviderId[] = CAPACITY_WIRE_ORDER.filter((id) => providerIdsWhere((d) => d.capacityTracked).includes(id));
export type CapacityProvider = CapacityProviderId;

/**
 * The provider keys every capacity response has carried since the wire began,
 * frozen in their wire order. Peers from before #3799 accept exactly these
 * keys and nothing else, so a response to a peer that hasn't agreed to the
 * `capacity-providers` control feature carries exactly these. Never derived
 * from descriptors: adding a tracked provider must not change it.
 */
export const CAPACITY_WIRE_REQUIRED = ['claude-code', 'copilot-cli', 'codex-cli'] as const satisfies readonly CapacityProviderId[];

/** Unknown provider keys a response may carry and still be read (they are ignored). */
const MAX_EXTRA_PROVIDER_KEYS = 32;
export type ProviderCapacity = 'available' | 'limited' | 'unavailable' | 'unknown';
export interface CapacityAgentCounts {
  running: number;
  sleeping: number;
  idleDurable: number;
}

export interface OnlineHandoffCapacity {
  machine: string;
  online: true;
  sampledAt: number;
  lastSeen: number | null;
  agents: CapacityAgentCounts;
  load: 'low' | 'medium' | 'high';
  disk: 'ample' | 'limited' | 'low';
  providers: Record<CapacityProvider, ProviderCapacity>;
  accepting_handoffs: boolean;
}

export interface OfflineHandoffCapacity {
  machine: string;
  online: false;
  lastSeen: number | null;
  accepting_handoffs: false;
}

export type HandoffCapacity = OnlineHandoffCapacity | OfflineHandoffCapacity;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const availability = (value: unknown): value is ProviderCapacity => typeof value === 'string' && ['available', 'limited', 'unavailable', 'unknown'].includes(value);
/**
 * A response's providers, read over CAPACITY_PROVIDERS. Every frozen required
 * key must be a valid availability. Another tracked key, when present, must be
 * valid too (a malformed known value refuses the response); when absent it
 * reads `unknown`, never available. Unknown extra keys are ignored, up to a
 * bound. Null for anything else.
 */
function readProviders(value: unknown): Record<CapacityProvider, ProviderCapacity> | null {
  if (!object(value)) return null;
  if (!CAPACITY_WIRE_REQUIRED.every((provider) => availability(value[provider]))) return null;
  const tracked: readonly string[] = CAPACITY_PROVIDERS;
  const extras = Object.keys(value).filter((key) => !tracked.includes(key) && !(CAPACITY_WIRE_REQUIRED as readonly string[]).includes(key));
  if (extras.length > MAX_EXTRA_PROVIDER_KEYS) return null;
  const result = {} as Record<CapacityProvider, ProviderCapacity>;
  for (const provider of CAPACITY_PROVIDERS) {
    if (!Object.prototype.hasOwnProperty.call(value, provider)) { result[provider] = 'unknown'; continue; }
    const v = value[provider];
    if (!availability(v)) return null;
    result[provider] = v;
  }
  return result;
}

/**
 * What goes on the wire to a peer. `full` only for a peer whose current
 * control link agreed to `capacity-providers`; anyone else gets exactly the
 * frozen legacy keys, which every older reader accepts.
 */
export function capacityForWire(capacity: HandoffCapacity, full: boolean): HandoffCapacity {
  if (!capacity.online || full) return capacity;
  const legacy = Object.fromEntries(CAPACITY_WIRE_REQUIRED.map((provider) => [provider, capacity.providers[provider]]));
  return { ...capacity, providers: legacy as Record<CapacityProvider, ProviderCapacity> };
}

/** Reconstruct an allowlisted result; never spread peer-provided metrics. */
export function parseHandoffCapacity(raw: unknown): HandoffCapacity {
  if (!object(raw) || typeof raw.machine !== 'string' || raw.machine !== raw.machine.toLowerCase() || !isMachineFingerprint(raw.machine)
    || (raw.lastSeen !== null && !integer(raw.lastSeen))) throw new Error('Invalid capacity response.');
  const lastSeen = integer(raw.lastSeen) ? raw.lastSeen : null;
  if (raw.online === false) {
    if (!keys(raw, ['machine', 'online', 'lastSeen', 'accepting_handoffs']) || raw.accepting_handoffs !== false) throw new Error('Invalid capacity response.');
    return { machine: raw.machine, online: false, lastSeen, accepting_handoffs: false };
  }
  if (raw.online !== true || !keys(raw, ['machine', 'online', 'sampledAt', 'lastSeen', 'agents', 'load', 'disk', 'providers', 'accepting_handoffs'])
    || !integer(raw.sampledAt) || !object(raw.agents) || !keys(raw.agents, ['running', 'sleeping', 'idleDurable'])
    || !integer(raw.agents.running) || !integer(raw.agents.sleeping) || !integer(raw.agents.idleDurable)
    || (raw.load !== 'low' && raw.load !== 'medium' && raw.load !== 'high')
    || (raw.disk !== 'ample' && raw.disk !== 'limited' && raw.disk !== 'low')
    || typeof raw.accepting_handoffs !== 'boolean') {
    throw new Error('Invalid capacity response.');
  }
  const providers = readProviders(raw.providers);
  if (!providers) throw new Error('Invalid capacity response.');
  return {
    machine: raw.machine, online: true, sampledAt: raw.sampledAt, lastSeen,
    agents: { running: raw.agents.running, sleeping: raw.agents.sleeping, idleDurable: raw.agents.idleDurable },
    load: raw.load, disk: raw.disk,
    providers,
    accepting_handoffs: raw.accepting_handoffs,
  };
}
