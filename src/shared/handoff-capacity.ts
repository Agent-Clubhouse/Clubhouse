import { isMachineFingerprint } from './agent-address';

export const CAPACITY_PROVIDERS = ['claude-code', 'copilot-cli', 'codex-cli'] as const;
export type CapacityProvider = typeof CAPACITY_PROVIDERS[number];
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
const providers = (value: unknown): value is Record<CapacityProvider, ProviderCapacity> => object(value)
  && keys(value, CAPACITY_PROVIDERS) && CAPACITY_PROVIDERS.every((provider) => availability(value[provider]));

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
    || !providers(raw.providers) || typeof raw.accepting_handoffs !== 'boolean') {
    throw new Error('Invalid capacity response.');
  }
  return {
    machine: raw.machine, online: true, sampledAt: raw.sampledAt, lastSeen,
    agents: { running: raw.agents.running, sleeping: raw.agents.sleeping, idleDurable: raw.agents.idleDurable },
    load: raw.load, disk: raw.disk,
    providers: {
      'claude-code': raw.providers['claude-code'], 'copilot-cli': raw.providers['copilot-cli'], 'codex-cli': raw.providers['codex-cli'],
    },
    accepting_handoffs: raw.accepting_handoffs,
  };
}
