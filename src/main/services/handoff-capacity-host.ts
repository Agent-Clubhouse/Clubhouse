import { app } from 'electron';
import { CAPACITY_PROVIDERS, type CapacityAgentCounts, type CapacityProvider, type ProviderCapacity } from '../../shared/handoff-capacity';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { getOrCreateIdentity } from './annex-identity';
import { getSettings, networkEnabled } from './annex-settings';
import { listDevices } from './annex-devices';
import { isMachineConnected, postToMachine } from './annex-client';
import { peekProjects } from './project-store';
import { peekDurableConfigs } from './agent-config';
import { agentRegistry } from './agent-registry';
import { isHeadless } from './headless-manager';
import { getAgentRuntime } from './agent-runtime';
import { peekProviderQuota } from './provider-quota';
import { holdsGrant } from './clubhouse-mcp/grant-check';
import { HandoffCapacityService, sampleHandoffCapacity } from './handoff-capacity';

export function acceptingRemoteHandoffs(): boolean {
  const settings = getSettings();
  return networkEnabled(settings) && settings.enableServer && settings.acceptHandoffs !== false;
}

/** Quota evidence already in memory only: no CLI, login or model request. */
export function capacityProviders(): Record<CapacityProvider, ProviderCapacity> {
  return Object.fromEntries(CAPACITY_PROVIDERS.map((provider) => {
    const { state } = peekProviderQuota(provider);
    return [provider, state === 'exhausted' ? 'unavailable' : state === 'near_limit' || state === 'low' ? 'limited'
      : state === 'known' ? 'available' : 'unknown'];
  })) as Record<CapacityProvider, ProviderCapacity>;
}

export async function capacityAgentCounts(): Promise<CapacityAgentCounts> {
  const counts: CapacityAgentCounts = { running: 0, sleeping: 0, idleDurable: 0 };
  const durable = new Set<string>();
  for (const project of await peekProjects()) {
    for (const agent of await peekDurableConfigs(project.path)) {
      if (isDisposedAgent(agent) || durable.has(agent.id)) continue;
      durable.add(agent.id);
      const runtime = getAgentRuntime(agent.id);
      if (isHeadless(agent.id)) counts.running++;
      else if (!runtime?.isRunning()) counts.sleeping++;
      else if (runtime.getState() === 'idle' && !runtime.hasPendingWork?.()) counts.idleDurable++;
      else counts.running++;
    }
  }
  for (const id of agentRegistry.getAllRegistrations().keys()) {
    if (!durable.has(id) && (isHeadless(id) || getAgentRuntime(id)?.isRunning())) counts.running++;
  }
  return counts;
}

let service: HandoffCapacityService | undefined;
let serviceMachine: string | undefined;
export function handoffCapacityService(): HandoffCapacityService {
  const machine = getOrCreateIdentity().fingerprint.toLowerCase();
  if (service && serviceMachine === machine) return service;
  serviceMachine = machine;
  service = new HandoffCapacityService({
    machine,
    authorize: async (callerId) => holdsGrant(callerId, 'device.read', { kind: 'app' }),
    computers: () => listDevices().filter((device) => device.role === 'member' && device.kind !== 'phone').map((device) => ({
      machine: device.fingerprint.toLowerCase(), online: isMachineConnected(device.fingerprint),
      lastSeen: Number.isFinite(Date.parse(device.lastSeen)) ? Date.parse(device.lastSeen) : null,
    })),
    sampleLocal: () => sampleLocalHandoffCapacity(),
    probeRemote: async (target) => {
      const response = await postToMachine(target, '/api/v1/network/handoff-capacity', {});
      if (response.status !== 200) throw new Error('Capacity probe is unavailable.');
      return response.body;
    },
  });
  return service;
}

export async function sampleLocalHandoffCapacity() {
  return sampleHandoffCapacity({
    machine: getOrCreateIdentity().fingerprint.toLowerCase(),
    agentCounts: capacityAgentCounts,
    projectVolumes: async () => {
      const projects = await peekProjects();
      return projects.length ? projects.map((project) => project.path) : [app.getPath('userData')];
    },
    providers: capacityProviders,
    acceptingHandoffs: acceptingRemoteHandoffs,
  });
}

/** Per authenticated member, before sampling. Bounded even with a hostile peer. */
const rates = new Map<string, number[]>();
export async function receiveCapacityProbe(machine: string, raw: unknown, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length) throw new Error('Invalid capacity request.');
  const times = (rates.get(machine) ?? []).filter((at) => now >= at && now - at < 60_000);
  if (times.length >= 30) throw new Error('Capacity probe rate limit reached.');
  for (const [key, values] of rates) if (values.every((at) => now - at >= 60_000)) rates.delete(key);
  if (!rates.has(machine) && rates.size >= 200) throw new Error('Capacity probe rate limit reached.');
  rates.set(machine, [...times, now]);
  return sampleLocalHandoffCapacity();
}
