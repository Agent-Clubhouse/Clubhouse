import { tagHandoffTransferError, type HandoffTransferDiagnostic } from '../../shared/handoff-transfer-diagnostics';
import { getAgentGrantChanges, getAgentGrantRevision } from './agent-grants-store';
import { localDirectionTools } from '../../shared/connection-grants';
import { deliverNow } from './clubhouse-mcp/tools/helper-delivery';
import { handoffProjectsLinked } from './handoff-project-links';
import { recoverPendingHandoffApply } from './handoff-apply';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeGitRemote } from '../../shared/git-remote';
import type { HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { HandoffWorker, HandoffProjectUnavailable, HandoffAuthorizationChanged } from './handoff-worker';
import { callerHandoffSource } from './handoff-preflight-host';
import { openHandoffRepository, readHandoffSnapshotManifest } from './handoff-snapshot';
import { requestHandoffTransfer, readHandoffTransferManifest } from './handoff-transfer-transport';
import { HandoffTransferSource } from './handoff-transfer-source';
import { assertPreparedHandoffSelection, bindPreparedHandoff, selectPreparedHandoff, settleHandoffPreparationBinding, pruneHandoffPreparations, preparedSourceForRecord,
  type HandoffPreparationSource, type HandoffPreparationSelection } from './handoff-preparations';
import { evaluateGrant, type GrantCallTarget } from '../../shared/agent-grants';
import { parseAgentAddress } from '../../shared/agent-address';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { isHandoffAgent, isTerminalHandoff, sameHandoffAgent, type Handoff, type HandoffAgent, type HandoffTarget } from '../../shared/handoffs';
import { safeHandoffDiagnosticPath, scanHandoffSecrets } from '../../shared/handoff-secrets';
import { getIdentity, getOrCreateIdentity } from './annex-identity';
import { getSettings, networkEnabled } from './annex-settings';
import { listPeers, trustOf } from './annex-peers';
import * as annexClient from './annex-client';
import { isNetworkComputer } from './annex-agent-calls';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { agentConfigGeneration, onAgentConfigChanged, peekDurableConfigs } from './agent-config';
import { onProjectsChanged, peekProjects } from './project-store';
import { getDispatcherState, isDispatcherAgentId, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { effectiveAgentGrants } from './agent-grants-service';
import { getConnectionDirection, localConnectionWakeOn, onConnectionGrantsChanged } from './connection-grants-store';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { notifyToolGateChange, onOrchestrationGateChange, isOrchestrationEnabled, isCrossProjectEnabled, orchestrationControl } from './clubhouse-mcp/orchestration-gate';
import { callerGrants } from './clubhouse-mcp/grant-check';
import { callTool, setHandoffParticipantCheck } from './clubhouse-mcp/tool-registry';
import { handoffAgreementCallApproved } from './clubhouse-mcp/handoff-permissions';
import { withCapacityDeadline } from './handoff-capacity';
import { HANDOFF_ACTIVE_LIMIT, HANDOFF_PEER_LIMIT, HandoffService, type HandoffAuthorization } from './handoff-service';
import { HandoffStore } from './handoff-store';
import { HandoffCoordinator, type HandoffSyncAdmission, type HandoffProducerAdmission } from './handoff-coordinator';
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

class HandoffSyncOwner implements HandoffSyncAdmission {
  private references = 1;
  private retired = false;
  private disposed = false;
  readonly settled: Promise<void>;
  private readonly complete: () => void;

  constructor(private readonly current: () => boolean, private readonly outgoing: () => void,
    private readonly dispose: () => void, private readonly released: () => void) {
    let complete!: () => void;
    this.settled = new Promise<void>((resolve) => { complete = resolve; });
    this.complete = complete;
  }

  retire(): void { this.retired = true; }
  check(): void {
    if (this.retired || this.disposed || !this.current()) {
      this.retire();
      throw new HandoffAuthorizationChanged();
    }
  }
  checkOutgoing(): void {
    this.check();
    try { this.outgoing(); }
    catch (error) { this.retire(); throw error; }
  }
  holdPost(): () => void {
    this.check();
    this.references++;
    return () => this.releaseReference();
  }
  release(): void {
    // Ending a sync cannot release its still-settling POST references.
    this.retire();
    this.released();
    this.complete();
    this.releaseReference();
  }
  private releaseReference(): void {
    if (--this.references === 0) {
      this.disposed = true;
      this.dispose();
    }
  }
}

interface Host { store: HandoffStore; commands: HandoffCommandStore; coordinator: HandoffCoordinator; machine: string; transfer: HandoffTransferSource; worker: HandoffWorker; ready: Promise<void>; reverseSyncs: Set<HandoffSyncOwner>; incoming: Set<HandoffSyncOwner>; producers: Set<HandoffProducerOwner>; stopping: boolean }
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
  let targetAdmission: (() => boolean) | undefined;
  if (action === 'handoff.accept' && stage === 'accepted' && request.target) {
    try { targetAdmission = await authorizeSelectedTarget(record, actor, request.target); }
    catch { return false; /* telemetry-exempt: a selected agent never acquires the brief without current target and Dispatcher rights */ }
  }
  if ((action === 'handoff.offer' && stage === 'offered') || (action === 'handoff.accept' && stage === 'accepted')) {
    const expectedRecipient = action === 'handoff.offer'
      ? 'agentId' in record.to ? addressText(record.to) : `dispatcher@${record.to.machine}` : undefined;
    const approved = await handoffAgreementCallApproved(actor.agentId, action, expectedRecipient);
    return approved && (targetAdmission?.() ?? true);
  }
  const location = await localAgent(actor.agentId);
  const grants = agentRegistry.get(actor.agentId) ? callerGrants(actor.agentId) : await effectiveAgentGrants(location.projectPath, actor.agentId);
  const peer = action === 'handoff.offer' ? record.to : record.from;
  const target = action === 'handoff.offer' ? await peerTarget(actor, peer) : await resolveAcceptancePeer(record, actor);
  return evaluateGrant({ caller: { kind: 'agent', agentId: actor.agentId, projectPath: location.projectPath }, action, target }, grants).outcome !== 'refuse';
}

class HandoffProducerOwner implements HandoffProducerAdmission {
  private references = 1;
  private retired = false;
  private readonly off: Array<() => void> = [];
  private readonly grants: string;
  private source?: HandoffPreparationSource;
  private sourceAgent?: string;
  private anchors: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  private target?: HandoffTarget;
  private targetProject?: string;
  private targetAuthority?: string;
  private selected?: HandoffPreparationSelection;
  private admittedId?: string;
  private observations = Promise.resolve();
  private sourceRevision = 0;
  private verifiedRevision = 0;
  private sourceFailed = false;
  private sourceFailure: unknown;
  private registrationLost = false;
  readonly settled: Promise<void>;
  private readonly complete: () => void;
  readonly actor: HandoffAgent;

  constructor(private readonly active: Host, private readonly agentId: string) {
    this.actor = Object.freeze({ agentId, machine: active.machine });
    this.grants = this.grantStamp();
    let complete!: () => void;
    this.settled = new Promise<void>((resolve) => { complete = resolve; });
    this.complete = complete;
    const changed = () => {
      if (this.grantStamp() !== this.grants || this.target && this.targetStamp() !== this.targetAuthority) this.retire();
    };
    this.off.push(onOrchestrationGateChange((id) => { if (id === agentId) changed(); }),
      bindingManager.onChange((id) => { if (id === agentId) changed(); }),
      onConnectionGrantsChanged(changed), onDispatcherChanged(changed),
      agentRegistry.onAuthChange((id) => {
        if (id !== agentId || agentRegistry.get(id)) return;
        this.registrationLost = true;
        if (this.source && !this.sourceAgent) this.retire();
      }));
  }

  private grantStamp(): string {
    return JSON.stringify(callerGrants(this.agentId).filter((grant) => grant.action === 'handoff.offer')
      .map((grant) => [grant.action, grant.target, grant.mode]));
  }
  private targetStamp(): string {
    if (!this.target) return '';
    const dispatcher = 'via' in this.target || this.target.machine === this.active.machine && isDispatcherAgentId(this.target.agentId);
    const peer = this.target.machine !== this.active.machine
      ? listPeers().find((candidate) => candidate.fingerprint.toLowerCase() === this.target!.machine) : undefined;
    const state = getDispatcherState();
    return JSON.stringify([
      'agentId' in this.target ? hasConnection(this.actor, this.target) : undefined,
      dispatcher && this.target.machine === this.active.machine ? [state.enabled, state.agentId, state.path] : undefined,
      peer ? [trustOf(peer), peer.kind] : undefined,
      this.source && (this.target.machine !== this.active.machine
        || this.targetProject && this.targetProject !== path.resolve(this.source.project.path)) ? isCrossProjectEnabled(this.agentId) : undefined,
    ]);
  }
  private agentIdentity(rows: Awaited<ReturnType<typeof peekDurableConfigs>>): string | undefined {
    const row = rows.find((candidate) => candidate.id === this.agentId && !isDisposedAgent(candidate));
    return row && JSON.stringify([row.id, row.createdAt, row.worktreePath]);
  }
  private observe(work: Promise<void>): void {
    this.sourceRevision++;
    this.observations = Promise.all([this.observations, work]).then((): void => undefined, (error: unknown) => {
      this.sourceFailed = true; this.sourceFailure = error; this.retire();
    });
  }
  async captureSource(source: HandoffPreparationSource): Promise<HandoffPreparationSource> {
    this.source = Object.freeze({ ...source, project: Object.freeze({ ...source.project }), bounds: Object.freeze({ ...source.bounds }) });
    this.sourceAgent = this.agentIdentity(await peekDurableConfigs(source.project.path));
    this.anchors = [source.project.path, source.worktreeRoot].map((member) => {
      const stat = fs.statSync(member, { bigint: true });
      if (!stat.isDirectory()) throw new HandoffAuthorizationChanged();
      return { path: member, dev: stat.dev, ino: stat.ino };
    });
    this.off.push(onAgentConfigChanged((changed) => {
      if (path.resolve(changed) !== path.resolve(source.project.path)) return;
      this.observe(peekDurableConfigs(source.project.path).then((rows) => {
        if (this.agentIdentity(rows) !== this.sourceAgent) this.retire();
      }));
    }), onProjectsChanged(() => {
      this.observe(peekProjects().then((projects) => {
        if (!projects.some((project) => project.id === source.project.id && path.resolve(project.path) === path.resolve(source.project.path))) this.retire();
      }));
    }));
    await this.verify();
    return this.source;
  }
  async captureTarget(target: HandoffTarget): Promise<void> {
    this.target = Object.freeze({ ...target });
    if (target.machine === this.active.machine) {
      const project = 'agentId' in target ? (await localAgent(target.agentId)).projectPath : getDispatcherState().path;
      this.targetProject = project && path.resolve(project);
    }
    this.targetAuthority = this.targetStamp();
  }
  select(selected: HandoffPreparationSelection): void { this.selected = selected; }
  retire(): void { this.retired = true; }
  check(): void {
    if (this.sourceFailed) throw this.sourceFailure;
    if (this.retired || this.source && !this.sourceAgent && this.registrationLost
      || host !== this.active || this.active.stopping || ownMachine() !== this.active.machine
      || this.grantStamp() !== this.grants || this.target && this.targetStamp() !== this.targetAuthority
      || this.sourceRevision !== this.verifiedRevision) {
      this.retire(); throw new HandoffAuthorizationChanged();
    }
    if (this.source) {
      this.source.secretPolicy.assertCurrent();
      for (const anchor of this.anchors) {
        const current = fs.statSync(anchor.path, { bigint: true });
        if (!current.isDirectory() || current.dev !== anchor.dev || current.ino !== anchor.ino) {
          this.retire(); throw new HandoffAuthorizationChanged();
        }
      }
      if (this.selected) assertPreparedHandoffSelection(this.selected);
      if (!this.sourceAgent) {
        const live = agentRegistry.get(this.agentId);
        if (!live || path.resolve(live.projectPath) !== path.resolve(this.source.project.path)
          || path.resolve(live.cwd || live.projectPath) !== path.resolve(this.source.worktreeRoot)) {
          this.retire(); throw new HandoffAuthorizationChanged();
        }
      }
    }
  }
  async verify(): Promise<void> {
    await this.observations;
    if (this.source) {
      const current = await callerHandoffSource(this.agentId);
      const rows = await peekDurableConfigs(this.source.project.path);
      await this.observations;
      if (current.project.id !== this.source.project.id || path.resolve(current.project.path) !== path.resolve(this.source.project.path)
        || path.resolve(current.worktreeRoot) !== path.resolve(this.source.worktreeRoot)
        || JSON.stringify(current.bounds) !== JSON.stringify(this.source.bounds) || this.agentIdentity(rows) !== this.sourceAgent) this.retire();
    }
    this.verifiedRevision = this.sourceRevision;
    this.check();
  }
  admit(record: Handoff): void {
    this.check();
    if (this.admittedId || !this.selected || !sameHandoffAgent(record.from, this.actor)
      || JSON.stringify(record.to) !== JSON.stringify(this.target)) throw new HandoffAuthorizationChanged();
    this.admittedId = record.id;
  }
  bind(record: Handoff): Promise<void> {
    if (record.id !== this.admittedId || !this.selected) throw new HandoffAuthorizationChanged();
    // The queue admitted these fixed values before either independent save.
    return bindPreparedHandoff(record, this.selected);
  }
  holdPost(): () => void {
    this.check();
    this.references++;
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  release(): void {
    if (--this.references !== 0) return;
    for (const unsubscribe of this.off) unsubscribe();
    void this.observations.then(() => { this.active.producers.delete(this); this.complete(); });
  }
}

/** Original host/source ownership starts before implicit preparation, not after its awaits. */
export async function offerCallerHandoff(agentId: string, input: {
  reference: string; task: Handoff['task']; mode: Handoff['mode']; manifest?: Handoff['manifest'];
}): Promise<Handoff> {
  const active = handoffHost();
  const producer = new HandoffProducerOwner(active, agentId);
  active.producers.add(producer);
  try {
    await active.ready;
    producer.check();
    const source = await producer.captureSource(await callerHandoffSource(agentId));
    const target = await resolveHandoffTarget(input.reference);
    await producer.captureTarget(target);
    const senderName = await handoffSenderName(agentId);
    await producer.verify();
    const selected = await selectPreparedHandoff(agentId, input.mode, input.manifest, source, () => producer.check());
    producer.select(selected);
    return await active.coordinator.offer({ to: target, senderName, task: input.task, mode: input.mode, manifest: selected.summary }, producer.actor, producer);
  } finally { producer.release(); }
}

/** Saved grants are synchronous; a change during any asynchronous lookup invalidates its result. */
function grantPolicyStamp(agents: HandoffAgent[]): string {
  return JSON.stringify(agents.filter((agent) => agent.machine === ownMachine()).map((agent) => [agent.agentId, getAgentGrantChanges(agent.agentId)]));
}

/** Per-operation lease, captured before asynchronous authorization/verification.
 * Revisions detect revoke-and-restore; notifications invalidate connection and
 * orchestration policy too. Disposal follows actual work, including timeouts. */
function transferAuthority(record: Handoff, peer: string) {
  const agents = [record.from, ...(record.acceptance ? [record.acceptance.by, record.acceptance.target] : [])];
  const localIds = new Set(agents.filter((a) => a.machine === ownMachine()).map((a) => a.agentId));
  const stamp = () => JSON.stringify([agentConfigGeneration(), grantPolicyStamp(agents),
    [...localIds].map((id) => getAgentGrantRevision(id)), getDispatcherState().enabled, getDispatcherState().agentId,
    [...localIds].map((id) => [id, isOrchestrationEnabled(id), isCrossProjectEnabled(id), orchestrationControl(id), callerGrants(id)])]);
  const expected = stamp();
  const participants = [...agents, ...('agentId' in record.to ? [record.to] : [])];
  const targets = new Set(participants.map(addressText));
  // Labels/instructions and bindings to other targets do not authorize this
  // handoff. Effective caller grants are captured separately in stamp().
  const bindingStamp = (part: 'membership' | 'permissions') => JSON.stringify([...localIds].map((id) =>
    [id, bindingManager.getBindingsForAgent(id).filter((wire) => wire.targetKind === 'agent' && targets.has(wire.targetId))
      .map((wire) => [wire.targetKind, wire.targetId, ...(part === 'permissions'
        ? [[...new Set(wire.disabledTools ?? [])].sort(), [...new Set(wire.enabledTools ?? [])].sort()] : [])])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  const bindings = { membership: bindingStamp('membership'), permissions: bindingStamp('permissions') };
  let changed = false;
  let changeReason: HandoffTransferDiagnostic = 'lease_notification';
  const authorityDiagnostic = (): HandoffTransferDiagnostic => {
    const before = JSON.parse(expected) as unknown[]; const current = JSON.parse(stamp()) as unknown[];
    const codes = ['lease_config_generation', 'lease_saved_grants', 'lease_grant_revision', 'lease_dispatcher', 'lease_dispatcher', 'lease_agent_authority'] as const;
    return codes.find((_, index) => JSON.stringify(before[index]) !== JSON.stringify(current[index])) ?? 'lease_authority';
  };
  const off = [onConnectionGrantsChanged(() => { changed = true; changeReason = 'lease_connection_notification'; }),
    bindingManager.onChange((id) => {
      if (!localIds.has(id)) return;
      const authorityChanged = stamp() !== expected;
      const membershipChanged = bindingStamp('membership') !== bindings.membership;
      const permissionsChanged = bindingStamp('permissions') !== bindings.permissions;
      if (!authorityChanged && !membershipChanged && !permissionsChanged) return;
      // Sticky even when the binding or its switches are restored before I/O
      // resumes. Benign refreshes cannot overwrite the real invalidation.
      changed = true;
      changeReason = authorityChanged ? authorityDiagnostic() : membershipChanged ? 'lease_binding_membership' : 'lease_binding_permissions';
    }),
    // This also announces handoff acceptance/progress and tool-list refreshes.
    // Invalidate only a real authority change, retaining the invalidation even
    // if the setting is restored before the pending filesystem await resolves.
    onOrchestrationGateChange((id) => { if (localIds.has(id) && stamp() !== expected) { changed = true; changeReason = authorityDiagnostic(); } })];
  return {
    check: () => {
      if (changed || stamp() !== expected || bindingStamp('permissions') !== bindings.permissions || peer !== ownMachine() && !isNetworkComputer(peer)
        || record.to.machine !== ownMachine() && !isNetworkComputer(record.to.machine)
        || record.from.machine !== ownMachine() && (!isNetworkComputer(record.from.machine) || !acceptsRemote())
        || 'agentId' in record.to && !(record.to.machine === ownMachine() && isDispatcherAgentId(record.to.agentId))
          && !hasConnection(record.from, record.to)) throw tagHandoffTransferError(new HandoffAuthorizationChanged(), changed ? changeReason : stamp() !== expected ? authorityDiagnostic() : bindingStamp('permissions') !== bindings.permissions
            ? bindingStamp('membership') !== bindings.membership ? 'lease_binding_membership' : 'lease_binding_permissions' : 'lease_peer');
    },
    dispose: () => { for (const unsubscribe of off) unsubscribe(); },
  };
}

async function authorizeSelectedTarget(record: Handoff, by: HandoffAgent, target: HandoffAgent): Promise<() => boolean> {
  if (sameHandoffAgent(by, target)) return () => true; // The receiver consumed its own exact approval.
  const machine = ownMachine();
  const stamp = grantPolicyStamp([by, target]);
  // Complete every asynchronous lookup before evaluating any connection or grant.
  const targetLocation = await localAgent(target.agentId);
  const targetGrants = agentRegistry.get(target.agentId) ? callerGrants(target.agentId) : await effectiveAgentGrants(targetLocation.projectPath, target.agentId);
  const senderLocation = record.from.machine === machine ? await localAgent(record.from.agentId) : undefined;
  const dispatcher = await localAgent(by.agentId);
  const grants = agentRegistry.get(by.agentId) ? callerGrants(by.agentId) : await effectiveAgentGrants(dispatcher.projectPath, by.agentId);
  const current = () => {
    if (stamp !== grantPolicyStamp([by, target]) || !getDispatcherState().enabled || !isDispatcherAgentId(by.agentId) || !hasConnection(by, target)) return false;
    const direction = getConnectionDirection(relative(by), relative(target));
    const binding = bindingManager.getBindingsForAgent(by.agentId).find((wire) => wire.targetKind === 'agent' && wire.targetId === target.agentId);
    const switches = localDirectionTools(direction, binding?.disabledTools, binding?.enabledTools);
    if (!localConnectionWakeOn(by.agentId, target.agentId) || !switches.allowed.includes('send_message')) return false;
    const senderTarget: GrantCallTarget = { kind: 'agent', agentId: addressText(record.from), relations: hasConnection(record.from, target) ? ['connected'] : [],
      isDispatcher: record.from.machine === machine && isDispatcherAgentId(record.from.agentId), ...(senderLocation && { projectPath: senderLocation.projectPath }) };
    if (evaluateGrant({ caller: { kind: 'agent', agentId: target.agentId, projectPath: targetLocation.projectPath }, action: 'handoff.accept', target: senderTarget }, targetGrants).outcome !== 'allow') return false;
    const peer: GrantCallTarget = { kind: 'agent', agentId: addressText(target), projectPath: targetLocation.projectPath, relations: ['connected'], isDispatcher: isDispatcherAgentId(target.agentId) };
    return (['agent.wake', 'agent.message'] as const).every((action) => evaluateGrant({ caller: { kind: 'agent', agentId: by.agentId, projectPath: dispatcher.projectPath }, action, target: peer }, grants).outcome === 'allow');
  };
  if (!current()) throw new HandoffAuthorizationChanged();
  return current;
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
  if (host?.stopping) throw new HandoffAuthorizationChanged();
  if (host?.machine === machine) return host;
  if (host && (host.reverseSyncs.size || host.incoming.size || host.producers.size)) {
    for (const owner of [...host.reverseSyncs, ...host.incoming, ...host.producers]) owner.retire();
    throw new HandoffAuthorizationChanged();
  }
  void host?.worker.stop();
  void host?.transfer.close();
  const store = new HandoffStore();
  const commands = new HandoffCommandStore();
  const service = new HandoffService({ machine, store, authorize,
    incomingAvailable: (record) => {
      const retained = store.list().filter((item) => !isTerminalHandoff(item.state) || item.from.machine !== item.to.machine && commands.acknowledged(item.id) !== item.version);
      return retained.length < HANDOFF_ACTIVE_LIMIT && (record.from.machine === machine || retained.filter((item) => item.to.machine === machine && item.from.machine === record.from.machine).length < HANDOFF_PEER_LIMIT);
    }, isDispatcher: (agent) => agent.machine === machine && isDispatcherAgentId(agent.agentId) && getDispatcherState().enabled });
  const coordinator = new HandoffCoordinator({
    machine, store, service, commands,
    bindOffer: bindPreparedHandoff, offerSettled: settleHandoffPreparationBinding,
    peerRemoved: (peer) => !isNetworkComputer(peer),
    connected: (peer) => isNetworkComputer(peer) && annexClient.isMachineConnected(peer),
    captureSync: (record, peer) => {
      const active = host;
      if (!active || active.coordinator !== coordinator || active.stopping || !isNetworkComputer(peer) || annexClient.isMachineConnected(peer)) return;
      const observation = annexClient.getControllerReadObservation(peer);
      if (!observation.ready) return;
      const freshOffer = record.from.machine === machine && record.to.machine !== machine && record.state === 'offered';
      const cancelled = () => commands.list().some((command) => command.id === record.id);
      const authority = freshOffer && !cancelled() ? transferAuthority(record, peer) : undefined;
      const owner = new HandoffSyncOwner(() => {
        const current = annexClient.getControllerReadObservation(peer);
        return host === active && !active.stopping && ownMachine() === machine && isNetworkComputer(peer)
          && !annexClient.isMachineConnected(peer) && current.ready && current.revision === observation.revision;
      }, () => {
        if (freshOffer && !cancelled()) {
          if (!authority) throw new HandoffAuthorizationChanged();
          authority.check();
        }
      }, () => authority?.dispose(), () => { active.reverseSyncs.delete(owner); });
      active.reverseSyncs.add(owner);
      return owner;
    },
    post: async (peer, body, admission) => {
      const release = admission?.holdPost();
      const response = await withCapacityDeadline(async (signal) => {
        try {
          if (admission) {
            if (signal.aborted) throw new HandoffAuthorizationChanged();
            if (body.op === 'offer') admission.checkOutgoing();
            else admission.check();
          }
          return await annexClient.postToMachine(peer, '/api/v1/network/handoffs', body, { signal, maxResponseBytes: 512 * 1024 });
        } finally { release?.(); }
      });
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
      if (isTerminalHandoff(record.state)) await host?.transfer.close(record.id);
      if (record.from.machine === machine && isTerminalHandoff(record.state)) await pruneHandoffPreparations(store.list());
      const participants = [record.from, ...('agentId' in record.to ? [record.to] : getDispatcherState().agentId ? [localHandoffAgent(getDispatcherState().agentId!)] : []), ...(record.acceptance ? [record.acceptance.target] : [])];
      for (const participant of participants) if (participant.machine === machine) notifyToolGateChange(participant.agentId);
      await notifyRecord(record);
      if (record.to.machine === machine && record.acceptance && !isTerminalHandoff(record.state)) void host?.worker.run(record.id);
    },
  });
  const transfer = new HandoffTransferSource({
    machine, record: (id) => store.get(id), prepared: preparedSourceForRecord, authority: transferAuthority,
    authorize: async (record, peer) => {
      if (peer !== machine && !isNetworkComputer(peer)
        || !await authorize({ record, actor: record.from, action: 'handoff.offer', stage: 'transferring' })) throw new Error('Handoff transfer unavailable.');
    },
  });
  const ready = service.recover().then(async (recovered) => {
    const projects = await peekProjects();
    for (const record of recovered) {
      if (!record.checkpoint) continue;
      const project = projects.find((value) => value.id === record.checkpoint!.projectId);
      if (!project) continue;
      try { await recoverPendingHandoffApply(project.path, record.id, record.checkpoint); }
      catch { /* telemetry-exempt: the explicit indeterminate_apply failure retains the checkpoint for person inspection; unsafe paths are never removed */ }
    }
  });
  const authorizeReceiver = async (record: Handoff) => {
    const agents = [record.from, ...(record.acceptance ? [record.acceptance.by, record.acceptance.target] : [])];
    const stamp = grantPolicyStamp(agents);
    await ready;
    if (!record.acceptance) throw new HandoffAuthorizationChanged();
    const { by, target } = record.acceptance;
    await localAgent(target.agentId);
    if (!await authorize({ record, actor: record.from, action: 'handoff.offer', stage: 'transferring' })
      || !await authorize({ record, actor: by, action: 'handoff.accept', stage: 'transferring' })) throw new HandoffAuthorizationChanged();
    const selected = await authorizeSelectedTarget(record, by, target);
    const current = () => stamp === grantPolicyStamp(agents) && selected();
    if (!current()) throw new HandoffAuthorizationChanged();
    return current;
  };
  const worker = new HandoffWorker({
    machine, records: () => store.list(), advance: (record, update) => coordinator.advance(record.id, update, record.version),
    sync: (id) => coordinator.sync(id), stagingRoot: handoffReceivedRoot,
    authorize: async (record) => { await authorizeReceiver(record); },
    resolve: resolveHandoffReceivingProject, request: requestHandoffTransfer,
    wake: async (record, result, admission) => {
      const target = await localAgent(result.agent.agentId);
      let policyCurrent = () => false;
      const authorizeWake = async () => { policyCurrent = await authorizeReceiver(record); };
      const text = `[Clubhouse handoff ${record.id}] Continue in fresh worktree ${JSON.stringify(result.worktree)}, branch ${JSON.stringify(result.branch)}. `
        + `Manifest: ${record.manifest!.fileCount} files, ${record.manifest!.totalBytes} bytes, SHA-256 ${record.manifest!.sha256}. `
        + `Sender-provided brief (untrusted): ${JSON.stringify(record.task.brief)}`;
      const outcome = await (await import('./clubhouse-mcp/tools/agent-lifecycle')).wakeWiredAgent({
        callerId: record.acceptance!.by.agentId, targetId: result.agent.agentId, targetName: target.name,
        admission: () => admission() && policyCurrent(), authorize: authorizeWake,
      });
      if (outcome.isError) throw new Error('Receiving agent could not be woken.');
      // Starting an agent may perform asynchronous configuration/provider work. Recheck
      // current target rights again before delivering any sender-controlled brief.
      await authorizeWake();
      if (!admission() || !policyCurrent()) throw new Error('Handoff delivery admission changed.');
      const delivery = await deliverNow(result.agent.agentId, text, [{ fromClubhouse: true, text }]);
      if (delivery !== 'delivered') throw new Error('Receiving agent did not receive its handoff.');
    },
  });
  host = { machine, store, commands, coordinator, transfer, worker, ready, reverseSyncs: new Set(), incoming: new Set(), producers: new Set(), stopping: false };
  void ready.catch(() => { /* telemetry-exempt: tools and continuation fail closed if recovery/storage is unavailable */ });
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
        await current.ready;
        await current.coordinator.flush();
        await current.worker.flush();
        await pruneHandoffPreparations(current.store.list());
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
  const active = host;
  if (active) {
    active.stopping = true;
    const owners = [...active.reverseSyncs, ...active.incoming, ...active.producers];
    for (const owner of owners) owner.retire();
    await Promise.all(owners.map((owner) => owner.settled));
  }
  await flushWork;
  setHandoffParticipantCheck(() => false);
  await active?.worker.stop();
  await active?.transfer.close();
  if (host === active) host = undefined;
  incomingRates.clear();
}

async function handoffReceivedRoot(): Promise<string> {
  let root = await fs.promises.realpath(app.getPath('userData'));
  for (const part of ['handoff-data', 'received']) {
    const next = path.join(root, part);
    try { await fs.promises.mkdir(next, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.promises.lstat(next);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !path.isAbsolute(next) || path.relative(next, await fs.promises.realpath(next)) !== '') throw new Error('Invalid receiving directory.');
    root = next;
  }
  return root;
}

async function isLinkedHandoffProject(projectId: string, record: Handoff): Promise<boolean> {
  const local = record.from.machine === ownMachine();
  const sourceProject = local ? (await callerHandoffSource(record.from.agentId)).project.id
    : Object.entries(annexClient.getSatellite(record.from.machine)?.snapshot?.agents ?? {}).find(([, agents]) => Array.isArray(agents) && agents.some((agent) => !!agent && typeof agent === 'object' && 'id' in agent && agent.id === record.from.agentId))?.[0];
  return !!sourceProject && handoffProjectsLinked(projectId, record.from.machine, sourceProject, local);
}

async function projectMatchesHandoff(project: { id: string; path: string }, manifest: HandoffWorktreeManifest, record: Handoff): Promise<boolean> {
  try {
    const repository = await openHandoffRepository(project.path);
    if (await isLinkedHandoffProject(project.id, record)) return true;
    const remote = normalizeGitRemote(manifest.repo.remote);
    if (remote) return normalizeGitRemote(repository.repo.remote) === remote;
    return (await repository.read(['cat-file', '-t', manifest.repo.base]))?.toString('ascii').trim() === 'commit';
  } catch { return false; /* telemetry-exempt: inaccessible or unrelated projects are never guessed */ }
}

async function resolveHandoffReceivingProject(record: Handoff) {
  if (!record.acceptance) throw new HandoffProjectUnavailable();
  const source = await callerHandoffSource(record.acceptance.target.agentId);
  const manifest = record.state === 'verifying'
    ? await readHandoffSnapshotManifest(path.join(await handoffReceivedRoot(), record.id), record.manifest!, source.bounds)
    : await readHandoffTransferManifest(record, source.bounds);
  if (!await projectMatchesHandoff(source.project, manifest, record)) throw new HandoffProjectUnavailable();
  return { projectId: source.project.id, projectRoot: source.project.path, bounds: source.bounds, secretPolicy: source.secretPolicy, linkedProject: await isLinkedHandoffProject(source.project.id, record) };
}

/** The addressed Dispatcher chooses an existing matching-project agent before accepting. */
export async function defaultHandoffReceivingAgent(agentId: string, id: string) {
  if (!isDispatcherAgentId(agentId)) return undefined;
  const record = handoffHost().coordinator.service.get(id, localHandoffAgent(agentId));
  if (record.to.machine !== ownMachine() || 'agentId' in record.to && record.to.agentId !== agentId) throw new Error('Only the addressed Dispatcher chooses a receiving agent.');
  if (record.acceptance) return record.acceptance.target;
  const manifest = await readHandoffTransferManifest(record);
  for (const project of [...await peekProjects()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!await projectMatchesHandoff(project, manifest, record)) continue;
    const agent = (await peekDurableConfigs(project.path)).filter((config) => !isDisposedAgent(config)
      && !(record.from.machine === ownMachine() && record.from.agentId === config.id)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (agent) return localHandoffAgent(agent.id);
  }
  return prepareNewHandoffHelper(agentId, id);
}

/** Internal same-machine reads use this boundary too; the HTTP route supplies its pinned peer. */
export async function receiveHandoffTransfer(machine: string, body: unknown, beforeRead?: () => void) {
  if (machine !== ownMachine() && !isNetworkComputer(machine)) throw new Error('Handoff transfer unavailable.');
  return handoffHost().transfer.receive(machine, body, beforeRead);
}

const incomingRates = new Map<string, number[]>();

function incomingOfferPolicy(record: Handoff) {
  const stamp = () => {
    const dispatcher = getDispatcherState();
    const receiver = 'agentId' in record.to ? record.to
      : dispatcher.agentId ? localHandoffAgent(dispatcher.agentId) : undefined;
    const localDispatcher = !!receiver && isDispatcherAgentId(receiver.agentId);
    return JSON.stringify([agentConfigGeneration(), acceptsRemote(), receiver, localDispatcher,
      localDispatcher || 'via' in record.to ? [dispatcher.enabled, dispatcher.agentId, dispatcher.path] : undefined,
      receiver && !localDispatcher && !('via' in record.to) ? hasConnection(record.from, receiver) : undefined]);
  };
  const original = stamp();
  let retired = false;
  const changed = () => { if (stamp() !== original) retired = true; };
  const offConnection = onConnectionGrantsChanged(changed), offDispatcher = onDispatcherChanged(changed);
  return {
    check: () => { changed(); if (retired) throw new HandoffAuthorizationChanged(); },
    dispose: () => { offConnection(); offDispatcher(); },
  };
}

export async function receiveNetworkHandoff(machine: string, body: unknown, currentRequest?: () => boolean): Promise<Handoff | { kind: 'refused'; record: Handoff }> {
  // The service gates new offers and acceptance. Retained status and sender
  // cancellation must still synchronize after the person disables incoming work.
  if (!isNetworkComputer(machine)) throw new Error('Handoff is unavailable.');
  const now = Date.now();
  for (const [peer, times] of incomingRates) if (times.every((at) => now < at || now - at >= 60_000)) incomingRates.delete(peer);
  const times = (incomingRates.get(machine) ?? []).filter((at) => now >= at && now - at < 60_000);
  if (times.length >= 60 || !incomingRates.has(machine) && incomingRates.size >= 200) throw new Error('Handoff rate limit reached.');
  incomingRates.set(machine, [...times, now]);
  const active = handoffHost();
  if (!currentRequest) return active.coordinator.receive(machine, body);
  let policy: ReturnType<typeof incomingOfferPolicy> | undefined;
  const owner = new HandoffSyncOwner(
    () => host === active && !active.stopping && ownMachine() === active.machine && currentRequest(),
    () => {}, () => policy?.dispose(), () => { active.incoming.delete(owner); },
  );
  active.incoming.add(owner);
  try {
    owner.check();
    return await active.coordinator.receive(machine, body, (newOffer) => {
      owner.check();
      if (newOffer) {
        policy ??= incomingOfferPolicy(newOffer);
        policy.check();
      }
    });
  } finally { owner.release(); }
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
  const manifest = await readHandoffTransferManifest(record);
  const candidates = projectReference === undefined ? projects : exact.length ? exact : projects.filter((candidate) => candidate.name.toLowerCase() === projectReference.toLowerCase());
  const matches = [];
  for (const project of candidates) if (await projectMatchesHandoff(project, manifest, record)) matches.push(project);
  if (projectReference === undefined && matches.length > 1) matches.splice(1);
  if (matches.length !== 1) throw new Error('Choose an unambiguous registered project for the new helper.');
  const project = matches[0];
  const name = `handoff-${id}`;
  const prior = (await peekDurableConfigs(project.path)).find((config) => config.name === name && !isDisposedAgent(config));
  if (prior) return localHandoffAgent(prior.id);
  const templateId = await (await import('./managed-agents')).managedAgents().defaultHelperTemplateId();
  const result = await callTool(agentId, 'create_managed_agent', { name, project: project.path, templateId, connectToDispatcher: true });
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
