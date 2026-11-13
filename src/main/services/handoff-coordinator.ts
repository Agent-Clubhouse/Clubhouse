import { randomUUID } from 'crypto';
import { isHandoffAgent, isTerminalHandoff, parseHandoff, sameHandoffAgent, type Handoff, type HandoffAgent, type HandoffOffer } from '../../shared/handoffs';
import { scanHandoffSecrets } from '../../shared/handoff-secrets';
import { assertHandoffExtension, type HandoffStorage } from './handoff-store';
import { HANDOFF_OFFER_TTL_MS, HandoffOfferRefused, HandoffService } from './handoff-service';

export interface HandoffCancellation {
  id: string;
  operationId: string;
  from: HandoffAgent;
  reason?: string;
}
export interface HandoffCommandStorage {
  list(): HandoffCancellation[];
  put(command: HandoffCancellation): Promise<void>;
  remove(operationId: string): Promise<void>;
  markUndelivered?(id: string): Promise<void>;
  markAttempted?(id: string): Promise<void>;
  isUndelivered?(id: string): boolean;
  acknowledge?(id: string, version: number): Promise<void>;
  acknowledged?(id: string): number | undefined;
  prune?(retained: ReadonlySet<string>): Promise<void>;
}
export interface HandoffCoordinatorOptions {
  machine: string;
  store: HandoffStorage;
  service: HandoffService;
  commands: HandoffCommandStorage;
  /** The existing pinned Annex computer transport, never a URL supplied by an agent. */
  post(machine: string, body: Record<string, unknown>): Promise<unknown>;
  connected(machine: string): boolean;
  authorizeOutgoing(record: Handoff): Promise<boolean>;
  changed?(record: Handoff): Promise<void>;
  now?: () => number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseHandoffCancellation(raw: unknown): HandoffCancellation {
  const value = raw as Partial<HandoffCancellation> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['id', 'operationId', 'from', 'reason'].includes(key))
    || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || !isHandoffAgent(value.from) || value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 512 || value.reason.includes('\0'))
    || scanHandoffSecrets('handoff-command.json', new TextEncoder().encode(JSON.stringify(value))).length) throw new Error('Invalid handoff cancellation.');
  return structuredClone(value as HandoffCancellation);
}

/** The immutable first version is the sender's durable offer/outbox entry. */
export function originalHandoffOffer(record: Handoff): Handoff {
  return parseHandoff({
    schemaVersion: 1, id: record.id, createdAt: record.createdAt, updatedAt: record.createdAt, version: 1,
    from: record.from, to: record.to, task: record.task, mode: record.mode,
    ...(record.senderName !== undefined && { senderName: record.senderName }),
    ...(record.manifest && { manifest: record.manifest }), state: 'offered', history: [record.history[0]],
  });
}

/**
 * Records are also the durable sync queue. Each retry replays the same immutable
 * offer or authoritative history, never a new agreement. Only the receiving
 * computer serializes decisions, including sender cancellation.
 */
export class HandoffCoordinator {
  private readonly syncing = new Map<string, Promise<void>>();
  private cursor = 0;
  private historyCursor = 0;
  private readonly acknowledged = new Map<string, number>();
  constructor(private readonly options: HandoffCoordinatorOptions) {}

  get service(): HandoffService { return this.options.service; }

  private async changed(record: Handoff): Promise<void> {
    try { await this.options.changed?.(record); }
    catch { /* telemetry-exempt: a notice cannot undo a committed agreement; it remains queryable */ }
  }

  async offer(input: HandoffOffer, sender: HandoffAgent): Promise<Handoff> {
    await this.prune();
    const record = await this.service.offer(input, sender);
    await this.options.commands.markUndelivered?.(record.id);
    await this.changed(record);
    await this.trySync(record.id);
    return this.options.store.get(record.id)!;
  }

  async respond(id: string, actor: HandoffAgent, accept: boolean, target?: HandoffAgent, reason?: string): Promise<Handoff> {
    const current = this.service.get(id, actor);
    // A repeated tool call cannot create a second response or a second worker.
    if (current.acceptance && accept && sameHandoffAgent(current.acceptance.by, actor)
      && sameHandoffAgent(current.acceptance.target, target ?? actor)) return current;
    const response = current.history[current.history.length - 1];
    if (!accept && current.state === 'declined' && response?.by.kind === 'agent' && sameHandoffAgent(response.by.address, actor)) return current;
    const record = await this.service.respond(id, actor, accept, current.version, target, reason);
    await this.changed(record);
    await this.trySync(id);
    return this.options.store.get(id)!;
  }

  async cancel(id: string, actor: HandoffAgent, reason?: string): Promise<Handoff> {
    const record = this.service.get(id, actor);
    if (!sameHandoffAgent(record.from, actor)) throw new Error('Only the sender can cancel.');
    if (record.state === 'cancelled') return record;
    if (['applying', 'applied', 'declined', 'failed'].includes(record.state)) throw new Error('This handoff can no longer be cancelled.');
    const pending = this.options.commands.list().find((command) => command.id === id);
    const command = pending ?? parseHandoffCancellation({ id, operationId: randomUUID(), from: actor, ...(reason !== undefined && { reason }) });
    await this.options.commands.put(command);
    if (record.to.machine === this.options.machine) await this.applyCancellation(command, this.options.machine);
    else await this.trySync(id);
    return this.options.store.get(id)!;
  }

  private async applyCancellation(command: HandoffCancellation, machine: string): Promise<Handoff> {
    const current = this.options.store.get(command.id);
    if (!current) throw new Error('Unknown handoff.');
    if (current.to.machine !== this.options.machine || command.from.machine !== machine || !sameHandoffAgent(command.from, current.from)) throw new Error('Invalid handoff cancellation source.');
    const prior = current.history.findIndex((event) => event.operationId === command.operationId);
    if (prior === -1 && ['applying', 'applied', 'declined', 'failed'].includes(current.state)) {
      if (machine === this.options.machine) await this.options.commands.remove(command.operationId);
      return current;
    }
    const record = await this.service.cancelAtReceiver(command.id, command.from, machine,
      prior === -1 ? current.version : prior, command.reason, command.operationId);
    await this.changed(record);
    if (machine === this.options.machine) await this.options.commands.remove(command.operationId);
    return record;
  }

  /** Called only after pinned membership/authentication checks, never an agent-selected origin. */
  async receive(machine: string, raw: unknown): Promise<Handoff | { kind: 'refused'; record: Handoff }> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff request.');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => !['op', 'record', 'command'].includes(key))) throw new Error('Invalid handoff request.');
    let record: Handoff;
    if (body.op === 'offer' && body.command === undefined) {
      await this.service.expireOffers();
      await this.prune();
      try { record = await this.service.receiveOffer(body.record, machine); }
      catch (error) {
        // A typed refusal consumes no receiver store slots and cannot become an endless outbox retry.
        if (error instanceof HandoffOfferRefused) return { kind: 'refused', record: error.record };
        throw error;
      }
    }
    else if (body.op === 'snapshot' && body.command === undefined) {
      const incoming = parseHandoff(body.record);
      // Retired terminal history is an acknowledgement sink, never a new
      // agreement or notice. Its receiving authority may still be awaiting ACK.
      if (!this.options.store.get(incoming.id) && isTerminalHandoff(incoming.state)
        && incoming.from.machine === this.options.machine && incoming.to.machine === machine
        && !scanHandoffSecrets('handoff-record.json', new TextEncoder().encode(JSON.stringify(incoming))).length) return incoming;
      record = await this.service.receiveSnapshot(incoming, machine);
    }
    else if (body.op === 'cancel') {
      const command = parseHandoffCancellation(body.command);
      if (body.record !== undefined) {
        const offer = parseHandoff(body.record);
        if (offer.id !== command.id) throw new Error('Invalid cancelled offer.');
        record = await this.service.receiveCancelledOffer(offer, command.from, machine, command.operationId, command.reason);
      } else record = await this.applyCancellation(command, machine);
    } else throw new Error('Invalid handoff request.');
    await this.changed(record);
    return record;
  }

  /** Sync failures retain records/commands for reconnect or the next bounded sweep. */
  private async trySync(id: string): Promise<void> {
    try { await this.sync(id); }
    catch {
      // telemetry-exempt: durable retry below; never reflect peer content, task text or a transport URL
    }
  }

  async sync(id: string): Promise<void> {
    const pending = this.syncing.get(id);
    if (pending) return pending;
    const run = this.syncRecord(id).finally(() => { this.syncing.delete(id); });
    this.syncing.set(id, run);
    return run;
  }

  private async syncRecord(id: string): Promise<void> {
    const record = this.options.store.get(id);
    if (!record) return;
    if (record.from.machine === record.to.machine) {
      for (const command of this.options.commands.list().filter((item) => item.id === id)) await this.applyCancellation(command, this.options.machine);
      return;
    }
    const sending = record.from.machine === this.options.machine;
    const peer = sending ? record.to.machine : record.from.machine;
    if (!this.options.connected(peer) || !await this.options.authorizeOutgoing(record) && !this.options.commands.list().some((command) => command.id === id)) return;
    const cancellation = sending ? this.options.commands.list().find((command) => command.id === id) : undefined;
    // Persist the attempt before transport: a crash/timeout can never be mistaken for no delivery.
    if (sending) await this.options.commands.markAttempted?.(id);
    const response = await this.options.post(peer, cancellation ? { op: 'cancel', command: cancellation, record: originalHandoffOffer(record) } : sending
      ? { op: 'offer', record: originalHandoffOffer(record) }
      : { op: 'snapshot', record });
    // Membership/grants can change while a request is in flight.
    if (!this.options.connected(peer) || !await this.options.authorizeOutgoing(record) && !this.options.commands.list().some((command) => command.id === id)) return;
    const refused = !!response && typeof response === 'object' && 'kind' in response && response.kind === 'refused';
    if (refused && (!sending || Object.keys(response).some((key) => !['kind', 'record'].includes(key)))) throw new Error('Invalid refusal.');
    const next = parseHandoff(refused && 'record' in response ? response.record : response);
    if (refused && (next.state !== 'failed' || !['refused', 'expired'].includes(next.failure?.code ?? ''))) throw new Error('Invalid refusal.');
    if (next.id !== id) throw new Error('Invalid handoff reply.');
    if (!sending) {
      assertHandoffExtension(record, next);
      if (next.version !== record.version) throw new Error('Invalid handoff reply.');
      this.acknowledged.set(id, record.version);
      await this.options.commands.acknowledge?.(id, record.version);
    }
    if (sending) {
      await this.service.receiveSnapshot(next, peer);
      if (isTerminalHandoff(next.state)) {
        await this.options.commands.acknowledge?.(id, next.version);
        for (const command of this.options.commands.list().filter((item) => item.id === id)) await this.options.commands.remove(command.operationId);
      }
      for (const command of this.options.commands.list().filter((item) => item.id === id)) {
        const cancelled = parseHandoff(await this.options.post(peer, { op: 'cancel', command }));
        if (cancelled.id !== id) throw new Error('Invalid handoff reply.');
        await this.service.receiveSnapshot(cancelled, peer);
        await this.options.commands.remove(command.operationId);
      }
    }
    await this.changed(this.options.store.get(id)!);
  }

  /** Only acknowledged terminal history is evictable; pending decisions/commands remain durable. */
  private async prune(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const candidates = this.options.store.list().filter((record) => isTerminalHandoff(record.state)
      && !this.options.commands.list().some((command) => command.id === record.id)
      && (record.from.machine === record.to.machine || this.options.commands.acknowledged?.(record.id) === record.version
        || this.acknowledged.get(record.id) === record.version)).sort((a, b) => b.updatedAt - a.updatedAt);
    const removed = new Set(candidates.filter((record, index) => index >= 200 || now - record.updatedAt >= 7 * 24 * 60 * 60_000).map((record) => record.id));
    if (removed.size) await this.options.store.prune?.(removed);
    for (const id of removed) this.acknowledged.delete(id);
    await this.options.commands.prune?.(new Set(this.options.store.list().map((record) => record.id)));
  }

  /** Bounded work per sweep, so retained history cannot flood a network peer. */
  async flush(): Promise<void> {
    for (const record of await this.service.expireOffers()) await this.changed(record);
    const now = (this.options.now ?? Date.now)();
    for (const record of this.options.store.list()) {
      if (record.state === 'offered' && record.from.machine === this.options.machine && record.to.machine !== this.options.machine
        && now >= record.createdAt + HANDOFF_OFFER_TTL_MS) {
        if (this.options.commands.isUndelivered?.(record.id)) {
          const cancelled = await this.service.cancelUndelivered(record.id);
          await this.options.commands.acknowledge?.(record.id, cancelled.version);
          for (const command of this.options.commands.list().filter((item) => item.id === record.id)) await this.options.commands.remove(command.operationId);
          await this.changed(cancelled);
        } else if (!this.options.commands.list().some((command) => command.id === record.id)) {
          await this.options.commands.put({ id: record.id, from: record.from, operationId: randomUUID(), reason: 'Offer expired.' });
        }
      }
    }
    await this.prune();
    const commands = new Set(this.options.commands.list().map((command) => command.id));
    const records = this.options.store.list();
    const active = records.filter((record) => commands.has(record.id)
      || record.from.machine !== record.to.machine && !isTerminalHandoff(record.state));
    const history = records.filter((record) => record.from.machine !== record.to.machine && isTerminalHandoff(record.state)
      && record.to.machine === this.options.machine && (this.options.commands.acknowledged?.(record.id) ?? this.acknowledged.get(record.id)) !== record.version && !commands.has(record.id));
    // Always service active work first; retained history cannot put one new
    // agreement behind a full archive. Reserve one slot for final responses.
    const count = Math.min(history.length ? 9 : 10, active.length);
    for (let index = 0; index < count; index++) await this.trySync(active[this.cursor++ % active.length].id);
    if (active.length) this.cursor %= active.length;
    for (let index = 0; index < Math.min(10 - count, history.length); index++) await this.trySync(history[this.historyCursor++ % history.length].id);
    if (history.length) this.historyCursor %= history.length;
  }
}
