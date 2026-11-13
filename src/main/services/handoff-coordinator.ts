import { randomUUID } from 'crypto';
import { isHandoffAgent, parseHandoff, sameHandoffAgent, type Handoff, type HandoffAgent, type HandoffOffer } from '../../shared/handoffs';
import { scanHandoffSecrets } from '../../shared/handoff-secrets';
import type { HandoffStorage } from './handoff-store';
import { HandoffService } from './handoff-service';

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
  constructor(private readonly options: HandoffCoordinatorOptions) {}

  get service(): HandoffService { return this.options.service; }

  private async changed(record: Handoff): Promise<void> {
    await this.options.changed?.(record);
  }

  async offer(input: HandoffOffer, sender: HandoffAgent): Promise<Handoff> {
    const record = await this.service.offer(input, sender);
    await this.changed(record);
    await this.trySync(record.id);
    return this.options.store.get(record.id)!;
  }

  async respond(id: string, actor: HandoffAgent, accept: boolean, target?: HandoffAgent, reason?: string): Promise<Handoff> {
    const current = this.service.get(id, actor);
    // A repeated tool call cannot create a second response or a second worker.
    if (current.acceptance && accept && sameHandoffAgent(current.acceptance.by, actor)
      && sameHandoffAgent(current.acceptance.target, target ?? actor)) return current;
    if (!accept && current.state === 'declined') return current;
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
    const prior = current.history.findIndex((event) => event.operationId === command.operationId);
    const record = await this.service.cancelAtReceiver(command.id, command.from, machine,
      prior === -1 ? current.version : prior, command.reason, command.operationId);
    await this.changed(record);
    if (machine === this.options.machine) await this.options.commands.remove(command.operationId);
    return record;
  }

  /** Called only after pinned membership/authentication checks, never an agent-selected origin. */
  async receive(machine: string, raw: unknown): Promise<Handoff> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff request.');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => !['op', 'record', 'command'].includes(key))) throw new Error('Invalid handoff request.');
    let record: Handoff;
    if (body.op === 'offer' && body.command === undefined) record = await this.service.receiveOffer(body.record, machine);
    else if (body.op === 'snapshot' && body.command === undefined) record = await this.service.receiveSnapshot(body.record, machine);
    else if (body.op === 'cancel' && body.record === undefined) {
      const command = parseHandoffCancellation(body.command);
      record = await this.applyCancellation(command, machine);
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
    if (!record || record.from.machine === record.to.machine) return;
    const sending = record.from.machine === this.options.machine;
    const peer = sending ? record.to.machine : record.from.machine;
    if (!this.options.connected(peer) || !await this.options.authorizeOutgoing(record)) return;
    const response = await this.options.post(peer, sending
      ? { op: 'offer', record: originalHandoffOffer(record) }
      : { op: 'snapshot', record });
    // Membership/grants can change while a request is in flight.
    if (!this.options.connected(peer) || !await this.options.authorizeOutgoing(record)) return;
    const next = parseHandoff(response);
    if (next.id !== id) throw new Error('Invalid handoff reply.');
    if (sending) {
      await this.service.receiveSnapshot(next, peer);
      for (const command of this.options.commands.list().filter((item) => item.id === id)) {
        const cancelled = parseHandoff(await this.options.post(peer, { op: 'cancel', command }));
        if (cancelled.id !== id) throw new Error('Invalid handoff reply.');
        await this.service.receiveSnapshot(cancelled, peer);
        await this.options.commands.remove(command.operationId);
      }
    }
    await this.changed(this.options.store.get(id)!);
  }

  /** Bounded work per sweep, so retained history cannot flood a network peer. */
  async flush(): Promise<void> {
    const records = this.options.store.list();
    if (!records.length) return;
    for (let count = 0; count < Math.min(10, records.length); count++) {
      await this.trySync(records[this.cursor++ % records.length].id);
    }
    this.cursor %= records.length;
  }
}
