import { evaluateGrant, type GrantCallTarget } from '../../shared/agent-grants';
import { parseAgentAddress } from '../../shared/agent-address';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isHandoffAgent, isTerminalHandoff, sameHandoffAgent, type Handoff, type HandoffAgent, type HandoffTarget } from '../../shared/handoffs';
import { safeHandoffDiagnosticPath, scanHandoffSecrets } from '../../shared/handoff-secrets';
import { getIdentity, getOrCreateIdentity } from './annex-identity';
import { getSettings, networkEnabled } from './annex-settings';
import { listPeers } from './annex-peers';
import * as annexClient from './annex-client';
import { isNetworkComputer } from './annex-agent-calls';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { peekDurableConfigs } from './agent-config';
import { peekProjects } from './project-store';
import { getDispatcherState, isDispatcherAgentId } from './dispatcher/dispatcher-service';
import { effectiveAgentGrants } from './agent-grants-service';
import { getConnectionDirection } from './connection-grants-store';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';
import { callerGrants } from './clubhouse-mcp/grant-check';
import { callTool, setHandoffParticipantCheck } from './clubhouse-mcp/tool-registry';
import { handoffAgreementCallApproved } from './clubhouse-mcp/handoff-permissions';
import { withCapacityDeadline } from './handoff-capacity';
import { HANDOFF_ACTIVE_LIMIT, HANDOFF_PEER_LIMIT, HandoffService, type HandoffAuthorization } from './handoff-service';
import { HandoffStore } from './handoff-store';
import { HandoffCoordinator } from './handoff-coordinator';
import { HandoffCommandStore } from './handoff-command-store';
import { publishFederationHandoff } from './dispatcher-federation-policy';

const MAX_REFERENCE = 256;
function ownMachine(): string { return getOrCreateIdentity().fingerprint.toLowerCase(); }
export function localHandoffAgent(agentId: string): HandoffAgent {
  const actor = { agentId, machine: ownMachine() };
  if (!isHandoffAgent(actor)) throw new Error('Invalid handoff caller.');
  return actor;
}
const relative = (agent: HandoffAgent) => ({ agentId: agent.agentId, ...(agent.machine !== ownMachine() && { machineId: agent.machine }) });
const addressText = (agent: HandoffAgent) => agent.machine === ownMachine() ? agent.agentId : `${agent.agentId}@${agent.machine}`;

async function localAgent(ref: string) {
  const dispatcher = getDispatcherState();
  if (dispatcher.enabled && dispatcher.agentId && [dispatcher.agentId, dispatcher.config?.name, 'dispatcher'].some((value) => typeof value === 'string' && value.toLowerCase() === ref.toLowerCase())) {
    return { address: localHandoffAgent(dispatcher.agentId), projectPath: dispatcher.path!, name: dispatcher.config?.name ?? 'Dispatcher' };
  }
  const found: Array<{ address: HandoffAgent; projectPath: string; name: string }> = [];
  for (const project of await peekProjects()) {
    for (const config of await peekDurableConfigs(project.path)) {
      if (!isDisposedAgent(config) && (config.id === ref || config.name.toLowerCase() === ref.toLowerCase())) found.push({ address: localHandoffAgent(config.id), projectPath: project.path, name: config.name });
    }
  }
  if (found.length === 1) return found[0];
  // Quick agents may receive an explicit agent-to-agent offer while alive.
  const running = agentRegistry.get(ref);
  if (!found.length && running) return { address: localHandoffAgent(ref), projectPath: running.projectPath, name: ref };
  throw new Error('Handoff agent is unavailable or ambiguous; use its id.');
}

export async function handoffSenderName(agentId: string): Promise<string> { return (await localAgent(agentId)).name; }

function resolveMachine(ref: string): string {
  const self = ownMachine();
  if (ref.toLowerCase() === self || ref.toLowerCase() === getSettings().alias.toLowerCase() || ref === 'local') return self;
  const peers = listPeers().filter((peer) => peer.role === 'member' && peer.kind !== 'phone'
    && (peer.fingerprint.toLowerCase() === ref.toLowerCase() || peer.alias.toLowerCase() === ref.toLowerCase()));
  if (peers.length !== 1) throw new Error('Handoff computer is unavailable or ambiguous; use its fingerprint.');
  return peers[0].fingerprint.toLowerCase();
}

export async function resolveHandoffTarget(reference: string): Promise<HandoffTarget> {
  if (!reference.trim() || reference.length > MAX_REFERENCE || reference.includes('\0')) throw new Error('Invalid handoff target.');
  if (reference.startsWith('machine:')) return { machine: resolveMachine(reference.slice(8)), via: 'dispatcher' };
  const at = reference.lastIndexOf('@');
  const machine = at > 0 ? resolveMachine(reference.slice(at + 1)) : ownMachine();
  const ref = at > 0 ? reference.slice(0, at) : reference;
  if (machine === ownMachine()) {
    const local = (await localAgent(ref)).address;
    return isDispatcherAgentId(local.agentId) ? { machine, via: 'dispatcher' } : local;
  }
  const snapshot = annexClient.getSatellite(machine)?.snapshot;
  const remoteDispatcher = (snapshot?.dispatcher as { agent?: { id?: string; name?: string } } | undefined)?.agent;
  if (ref.toLowerCase() === 'dispatcher' || remoteDispatcher && [remoteDispatcher.id, remoteDispatcher.name].some((value) => typeof value === 'string' && value.toLowerCase() === ref.toLowerCase())) return { machine, via: 'dispatcher' };
  const candidates = Object.values(snapshot?.agents ?? {}).flat().filter((raw): raw is { id: string; name: string } => !!raw && typeof raw === 'object'
    && 'id' in raw && typeof raw.id === 'string' && 'name' in raw && typeof raw.name === 'string');
  const matches = candidates.filter((candidate) => candidate.id === ref || candidate.name.toLowerCase() === ref.toLowerCase());
  if (matches.length > 1) throw new Error('Handoff agent is ambiguous; use its id.');
  const wires = bindingManager.getAllBindings().filter((wire) => wire.targetKind === 'agent' && parseAgentAddress(wire.targetId).machine === machine
    && (wire.targetName === ref || wire.label === ref || parseAgentAddress(wire.targetId).agentId === ref));
  const ids = new Set(matches.map((candidate) => candidate.id).concat(wires.map((wire) => parseAgentAddress(wire.targetId).agentId)));
  if (ids.size > 1) throw new Error('Handoff agent is ambiguous; use its id.');
  const target = { machine, agentId: [...ids][0] ?? ref };
  if (!isHandoffAgent(target)) throw new Error('Invalid handoff agent.');
  return target;
}

function hasConnection(from: HandoffAgent, to: HandoffAgent): boolean {
  return !!getConnectionDirection(relative(from), relative(to))?.link
    || from.machine === ownMachine() && bindingManager.getBindingsForAgent(from.agentId).some((wire) => wire.targetKind === 'agent' && wire.targetId === addressText(to));
}

async function peerTarget(actor: HandoffAgent, peer: HandoffTarget): Promise<GrantCallTarget> {
  const dispatcher = 'via' in peer || peer.machine === ownMachine() && isDispatcherAgentId(peer.agentId);
  const connected = 'agentId' in peer && hasConnection(actor, peer);
  if (!connected && !dispatcher) throw new Error('A handoff needs an existing connection or a receiving Dispatcher.');
  const local = 'agentId' in peer && peer.machine === ownMachine() ? await localAgent(peer.agentId) : undefined;
  return {
    kind: 'agent', agentId: 'agentId' in peer ? addressText(peer) : `dispatcher@${peer.machine}`,
    relations: connected ? ['connected'] : [], isDispatcher: dispatcher,
    ...('via' in peer && peer.machine !== ownMachine() && { remoteDispatcher: true }),
    ...(local && { projectPath: local.projectPath }),
  };
}

export async function resolveHandoffGrantTarget(agentId: string, args: Record<string, unknown>): Promise<GrantCallTarget> {
  // Run before Ask first too: neither approval text nor an outgoing offer may contain credentials.
  if (scanHandoffSecrets('handoff-arguments.json', new TextEncoder().encode(JSON.stringify(args))).length) throw new Error('Handoff metadata is blocked by secret rules.');
  const actor = localHandoffAgent(agentId);
  if (typeof args.to === 'string') return peerTarget(actor, await resolveHandoffTarget(args.to));
  if (typeof args.id === 'string') {
    const record = handoffHost().coordinator.service.get(args.id, actor);
    return resolveAcceptancePeer(record, actor);

  }
  throw new Error('Missing handoff target.');
}

function acceptsRemote(): boolean {
  const settings = getSettings();
  return networkEnabled(settings) && settings.enableServer && !('acceptHandoffs' in settings && settings.acceptHandoffs === false);
}

interface Host { store: HandoffStore; commands: HandoffCommandStore; coordinator: HandoffCoordinator; machine: string }
let host: Host | undefined;
let sweep: ReturnType<typeof setInterval> | undefined;
let offConnected: (() => void) | undefined;
let flushWork: Promise<void> | undefined;

async function authorize(request: HandoffAuthorization): Promise<boolean> {
  const { record, actor, action, stage } = request;
  if (record.to.machine !== ownMachine() && !isNetworkComputer(record.to.machine)) return false;
  if (record.from.machine !== ownMachine() && (!isNetworkComputer(record.from.machine) || !acceptsRemote())) return false;
  const receiver = 'agentId' in record.to ? record.to : (() => {
    const dispatcher = getDispatcherState();
    return dispatcher.enabled && dispatcher.agentId ? localHandoffAgent(dispatcher.agentId) : null;
  })();
  if (record.to.machine === ownMachine() && !receiver) return false;
  if (receiver?.machine === ownMachine()) {
    try { await localAgent(receiver.agentId); }
    catch {
      // telemetry-exempt: removed/unknown receivers never acquire an offer
      return false;
    }
  }
  if (receiver && !('via' in record.to) && !(receiver.machine === ownMachine() && isDispatcherAgentId(receiver.agentId)) && !hasConnection(record.from, receiver)) return false;
  if (actor.machine !== ownMachine()) return true; // Its own computer checks its saved grant before sending.
  if ((action === 'handoff.offer' && stage === 'offered') || (action === 'handoff.accept' && stage === 'accepted')) {
    return handoffAgreementCallApproved(actor.agentId, action);
  }
  const location = await localAgent(actor.agentId);
  const grants = agentRegistry.get(actor.agentId) ? callerGrants(actor.agentId) : await effectiveAgentGrants(location.projectPath, actor.agentId);
  const peer = action === 'handoff.offer' ? record.to : record.from;
  const target = action === 'handoff.offer' ? await peerTarget(actor, peer) : await resolveAcceptancePeer(record, actor);
  return evaluateGrant({ caller: { kind: 'agent', agentId: actor.agentId, projectPath: location.projectPath }, action, target }, grants).outcome !== 'refuse';
}

async function resolveAcceptancePeer(record: Handoff, actor: HandoffAgent): Promise<GrantCallTarget> {
  const receiver = 'agentId' in record.to ? record.to : actor;
  const original = await peerTarget(record.from, receiver);
  const sender = record.from.machine === ownMachine() ? await localAgent(record.from.agentId) : undefined;
  return { kind: 'agent', agentId: addressText(record.from), relations: original.relations,
    isDispatcher: record.from.machine === ownMachine() && isDispatcherAgentId(record.from.agentId), ...(sender && { projectPath: sender.projectPath }) };
}

async function notifyRecord(record: Handoff): Promise<void> {
  const active = host;
  if (!active) return;
  // Replayed by the retained-record sweep if memory is temporarily unavailable.
  if (record.from.machine === active.machine && record.to.machine !== active.machine && 'via' in record.to) await publishFederationHandoff(record);
  let recipient: HandoffAgent | undefined;
  if (record.state === 'offered' && record.to.machine === active.machine) {
    const id = 'agentId' in record.to ? record.to.agentId : getDispatcherState().agentId;
    if (id) recipient = localHandoffAgent(id);
  } else if (['accepted', 'declined', 'cancelled', 'failed', 'applied'].includes(record.state) && record.from.machine === active.machine) recipient = record.from;
  if (!recipient || sameHandoffAgent(recipient, record.from) && record.state === 'offered') return;
  const key = `${record.id}:${recipient.agentId}`;
  if (active.commands.hasNotice(key, record.version)) return;
  const runtime = getAgentRuntime(recipient.agentId);
  if (!runtime?.isRunning()) return; // A retained offer is delivered when its receiver next wakes.
  if (!await active.commands.claimNotice(key, record.version)) return;
  const senderName = record.senderName ?? (record.from.machine === active.machine ? (await localAgent(record.from.agentId)).name : record.from.agentId);
  const machineName = record.from.machine === active.machine ? getSettings().alias : listPeers().find((peer) => peer.fingerprint.toLowerCase() === record.from.machine)?.alias ?? 'a paired computer';
  const remoteResult = record.from.machine === active.machine && record.to.machine !== active.machine && 'via' in record.to
    ? `Result from ${(await import('./dispatcher-presence')).remoteDispatcherLabelFor(record.to.machine) ?? `Dispatcher on ${listPeers().find((peer) => peer.fingerprint.toLowerCase() === record.to.machine)?.alias ?? record.to.machine}`}. ` : '';
  const text = `[Clubhouse handoff ${record.id}] Sender display name (untrusted): ${JSON.stringify(safeHandoffDiagnosticPath(senderName))}. Computer: ${JSON.stringify(safeHandoffDiagnosticPath(machineName))}. State: ${record.state}. ${remoteResult}Task title (untrusted): ${JSON.stringify(record.task.title)}. Mode: ${record.mode}. `
    + `${record.manifest ? `Manifest: ${record.manifest.fileCount} files, ${record.manifest.totalBytes} bytes, SHA-256 ${record.manifest.sha256}. ` : ''}`
    + (record.state === 'offered' ? 'Use get_handoff for the brief and respond_to_handoff to agree or decline.' : 'Use get_handoff for the retained history and result.');
  await runtime.sendMessage(text, { source: 'mcp', clientCommandId: `handoff:${key}:${record.version}`, routed: [{ fromClubhouse: true, text }] });
  await active.commands.deliveredNotice(key, record.version);
}

export function handoffHost(): Host {
  const machine = ownMachine();
  if (host?.machine === machine) return host;
  const store = new HandoffStore();
  const commands = new HandoffCommandStore();
  const service = new HandoffService({ machine, store, authorize,
    incomingAvailable: (record) => {
      const retained = store.list().filter((item) => !isTerminalHandoff(item.state) || item.from.machine !== item.to.machine && commands.acknowledged(item.id) !== item.version);
      return retained.length < HANDOFF_ACTIVE_LIMIT && (record.from.machine === machine || retained.filter((item) => item.to.machine === machine && item.from.machine === record.from.machine).length < HANDOFF_PEER_LIMIT);
    }, isDispatcher: (agent) => agent.machine === machine && isDispatcherAgentId(agent.agentId) && getDispatcherState().enabled });
  const coordinator = new HandoffCoordinator({
    machine, store, service, commands,
    peerRemoved: (peer) => !isNetworkComputer(peer),
    connected: (peer) => isNetworkComputer(peer) && annexClient.isMachineConnected(peer),
    post: async (peer, body) => {
      const response = await withCapacityDeadline((signal) => annexClient.postToMachine(peer, '/api/v1/network/handoffs', body, { signal, maxResponseBytes: 512 * 1024 }));
      if (response.status !== 200) throw new Error('Handoff synchronization is unavailable.');
      return response.body;
    },
    authorizeOutgoing: async (record) => {
      const peer = record.from.machine === machine ? record.to.machine : record.from.machine;
      if (!isNetworkComputer(peer)) return false;
      // Authoritative history remains queryable after revocation. A sender's
      // not-yet-delivered offer still needs its current grant and connection.
      if (record.from.machine !== machine || record.state !== 'offered') return true;
      try {
        const location = await localAgent(record.from.agentId);
        const grants = agentRegistry.get(record.from.agentId) ? callerGrants(record.from.agentId) : await effectiveAgentGrants(location.projectPath, record.from.agentId);
        return evaluateGrant({ caller: { kind: 'agent', agentId: record.from.agentId, projectPath: location.projectPath }, action: 'handoff.offer', target: await peerTarget(record.from, record.to) }, grants).outcome !== 'refuse';
      } catch {
        // telemetry-exempt: a missing caller or connection stops the outgoing offer
        return false;
      }
    },
    changed: async (record) => {
      const participants = [record.from, ...('agentId' in record.to ? [record.to] : getDispatcherState().agentId ? [localHandoffAgent(getDispatcherState().agentId!)] : []), ...(record.acceptance ? [record.acceptance.target] : [])];
      for (const participant of participants) if (participant.machine === machine) notifyToolGateChange(participant.agentId);
      await notifyRecord(record);
    },
  });
  host = { machine, store, commands, coordinator };
  void service.recover().catch(() => { /* telemetry-exempt: tools fail closed if recovery/storage is unavailable */ });
  return host;
}

export function startHandoffs(): void {
  if (sweep) return;
  setHandoffParticipantCheck((agentId) => {
    try { return !!getIdentity() && handoffHost().store.list().some((record) => record.from.agentId === agentId && record.from.machine === ownMachine()
      || 'agentId' in record.to && record.to.agentId === agentId && record.to.machine === ownMachine()
      || 'via' in record.to && record.to.machine === ownMachine() && isDispatcherAgentId(agentId)
      || !!record.acceptance && record.acceptance.target.agentId === agentId && record.acceptance.target.machine === ownMachine()); }
    catch {
      // telemetry-exempt: no permission or record is inferred from unreadable storage
      return false;
    }
  });
  const flush = (): Promise<void> => {
    if (flushWork) return flushWork;
    if (!getIdentity()) return Promise.resolve();
    const current = handoffHost();
    flushWork = (async () => {
      try {
        await current.coordinator.flush();
        for (const record of current.store.list()) await notifyRecord(record);
      } catch { /* telemetry-exempt: durable records/commands retry; tools report unreadable storage explicitly */ }
    })().finally(() => { flushWork = undefined; });
    return flushWork;
  };
  offConnected = annexClient.onSatelliteConnected(() => { void flush(); });
  sweep = setInterval(() => { void flush(); }, 30_000);
  sweep.unref?.();
  void flush();
}

export async function stopHandoffs(): Promise<void> {
  if (sweep) clearInterval(sweep);
  sweep = undefined;
  offConnected?.();
  offConnected = undefined;
  await flushWork;
  setHandoffParticipantCheck(() => false);
  host = undefined;
  incomingRates.clear();
}

const incomingRates = new Map<string, number[]>();
export async function receiveNetworkHandoff(machine: string, body: unknown): Promise<Handoff | { kind: 'refused'; record: Handoff }> {
  // The service gates new offers and acceptance. Retained status and sender
  // cancellation must still synchronize after the person disables incoming work.
  if (!isNetworkComputer(machine)) throw new Error('Handoff is unavailable.');
  const now = Date.now();
  for (const [peer, times] of incomingRates) if (times.every((at) => now < at || now - at >= 60_000)) incomingRates.delete(peer);
  const times = (incomingRates.get(machine) ?? []).filter((at) => now >= at && now - at < 60_000);
  if (times.length >= 60 || !incomingRates.has(machine) && incomingRates.size >= 200) throw new Error('Handoff rate limit reached.');
  incomingRates.set(machine, [...times, now]);
  return handoffHost().coordinator.receive(machine, body);
}

/** New receiving agents use the normal managed creation grant and helper template. No model runs before apply. */
export async function prepareNewHandoffHelper(agentId: string, id: string, projectReference?: string): Promise<import('./clubhouse-mcp/types').McpToolResult | HandoffAgent> {
  const record = handoffHost().coordinator.service.get(id, localHandoffAgent(agentId));
  if (!isDispatcherAgentId(agentId) || record.to.machine !== ownMachine()
    || 'agentId' in record.to && record.to.agentId !== agentId) throw new Error('Only the addressed Dispatcher can choose a new helper.');
  if (!await handoffAgreementCallApproved(agentId, 'handoff.accept')) throw new Error('Handoff acceptance is not authorized.');
  if (record.acceptance) return record.acceptance.target;
  if (record.state !== 'offered') throw new Error('Handoff cannot be accepted.');
  const projects = [...await peekProjects()].sort((a, b) => a.id.localeCompare(b.id));
  const exact = projectReference === undefined ? [] : projects.filter((candidate) => candidate.id === projectReference || candidate.path === projectReference);
  const matches = projectReference === undefined ? projects.slice(0, 1) : exact.length ? exact : projects.filter((candidate) => candidate.name.toLowerCase() === projectReference.toLowerCase());
  if (matches.length !== 1) throw new Error('Choose an unambiguous registered project for the new helper.');
  const project = matches[0];
  const name = `handoff-${id}`;
  const prior = (await peekDurableConfigs(project.path)).find((config) => config.name === name && !isDisposedAgent(config));
  if (prior) return localHandoffAgent(prior.id);
  const templateId = await (await import('./managed-agents')).managedAgents().defaultHelperTemplateId();
  const result = await callTool(agentId, 'create_managed_agent', { name, project: project.path, templateId, connectToDispatcher: false });
  if (!result.isError) {
    for (const block of result.content) {
      if (block.type !== 'text') continue;
      try {
        const body = JSON.parse(block.text);
        if (typeof body.id === 'string' && body.status !== 'partial' && body.status !== 'needs_approval') return localHandoffAgent(body.id);
      } catch { /* telemetry-exempt: typed helper outcome only, never reflect diagnostics */ }
    }
  }
  return result;
}
