import { randomUUID } from 'crypto';
import { isMachineFingerprint } from '../../shared/agent-address';
import {
  isHandoffAgent, isTerminalHandoff, parseHandoff, sameHandoffAgent, transitionHandoff,
  type Handoff, type HandoffAgent, type HandoffOffer, type HandoffTransition,
} from '../../shared/handoffs';
import { assertHandoffExtension, type HandoffStorage } from './handoff-store';

export interface HandoffAuthorization {
  action: 'handoff.offer' | 'handoff.accept';
  actor: HandoffAgent;
  record: Handoff;
  stage: Handoff['state'];
}

export interface HandoffServiceOptions {
  machine: string;
  store: HandoffStorage;
  /** Must check the current grant and connection on the machine owning the action. */
  authorize(request: HandoffAuthorization): Promise<boolean>;
  isDispatcher(agent: HandoffAgent): boolean;
  now?: () => number;
  newId?: () => string;
}

type Advance = Extract<HandoffTransition, { state: 'transferring' | 'applying' | 'applied' | 'failed' }>
  | { state: 'verifying' };
type AdvanceInput = Advance extends infer T ? T extends Advance ? Omit<T, 'operationId' | 'at' | 'by'> : never : never;

/**
 * The receiving machine serializes all decisions after the immutable offer.
 * Sender cancellation must travel durably to that authority; it is not a
 * local terminal state that can race a remote apply.
 */
export class HandoffService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: HandoffServiceOptions) {
    if (!isMachineFingerprint(options.machine) || options.machine !== options.machine.toLowerCase()) throw new Error('Invalid handoff machine.');
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  private requireLocal(agent: HandoffAgent): void {
    if (!isHandoffAgent(agent) || agent.machine !== this.options.machine) throw new Error('Handoff caller is not local.');
  }

  private requireReceiver(record: Handoff): void {
    if (record.to.machine !== this.options.machine) throw new Error('Only the receiving machine can decide this handoff.');
  }

  private receiverAgent(record: Handoff, actor: HandoffAgent): boolean {
    return 'agentId' in record.to ? sameHandoffAgent(record.to, actor)
      : actor.machine === record.to.machine && this.options.isDispatcher(actor);
  }

  private participant(record: Handoff, actor: HandoffAgent): boolean {
    return sameHandoffAgent(record.from, actor) || this.receiverAgent(record, actor)
      || !!record.acceptance && sameHandoffAgent(record.acceptance.target, actor);
  }

  get(id: string, actor: HandoffAgent): Handoff {
    this.requireLocal(actor);
    const record = this.options.store.get(id);
    if (!record || !this.participant(record, actor)) throw new Error('Handoff is unavailable to this agent.');
    return record;
  }

  list(actor: HandoffAgent, direction?: 'sent' | 'received', state?: Handoff['state']): Handoff[] {
    this.requireLocal(actor);
    return this.options.store.list().filter((record) => this.participant(record, actor)
      && (!direction || (direction === 'sent' ? sameHandoffAgent(record.from, actor) : !sameHandoffAgent(record.from, actor)))
      && (!state || record.state === state));
  }

  async offer(input: HandoffOffer, sender: HandoffAgent): Promise<Handoff> {
    this.requireLocal(sender);
    const at = this.now();
    const record = parseHandoff({
      ...input, schemaVersion: 1, id: this.newId(), createdAt: at, updatedAt: at, version: 1, from: sender,
      state: 'offered', history: [{ operationId: this.newId(), at, by: { kind: 'agent', address: sender }, state: 'offered' }],
    });
    if (!await this.options.authorize({ action: 'handoff.offer', actor: sender, record, stage: 'offered' })) throw new Error('Handoff offer is not authorized.');
    return this.options.store.transact(record.id, (current) => {
      if (current) throw new Error('Handoff id already exists.');
      return record;
    });
  }

  async receiveOffer(raw: unknown, authenticatedMachine: string): Promise<Handoff> {
    const record = parseHandoff(raw);
    this.requireReceiver(record);
    if (record.version !== 1 || record.from.machine !== authenticatedMachine) throw new Error('Invalid handoff offer source.');
    return this.options.store.transact(record.id, async (current) => {
      if (current) {
        assertHandoffExtension(record, current);
        return current;
      }
      if (!await this.options.authorize({ action: 'handoff.offer', actor: record.from, record, stage: 'offered' })) throw new Error('Handoff offer is not authorized.');
      return record;
    });
  }

  async respond(id: string, actor: HandoffAgent, accept: boolean, expectedVersion: number, target?: HandoffAgent, reason?: string, operationId = this.newId()): Promise<Handoff> {
    this.requireLocal(actor);
    return this.options.store.transact(id, async (record) => {
      if (!record) throw new Error('Handoff is unavailable to this agent.');
      this.requireReceiver(record);
      if (!this.receiverAgent(record, actor)) throw new Error('Only the addressed receiver can respond.');
      if (!await this.options.authorize({ action: 'handoff.accept', actor, record, stage: 'accepted' })) throw new Error('Handoff response is not authorized.');
      const base = {
        operationId, at: Math.max(this.now(), record.updatedAt),
        by: { kind: 'agent' as const, address: actor }, ...(reason !== undefined && { reason }),
      };
      return transitionHandoff(record, accept
        ? { ...base, state: 'accepted', target: target ?? actor }
        : { ...base, state: 'declined' }, expectedVersion);
    });
  }

  /** Called locally or from an authenticated, durably queued sender command. */
  async cancelAtReceiver(id: string, sender: HandoffAgent, authenticatedMachine: string, expectedVersion: number, reason?: string, operationId = this.newId()): Promise<Handoff> {
    if (!isHandoffAgent(sender) || sender.machine !== authenticatedMachine) throw new Error('Invalid handoff cancellation source.');
    return this.options.store.transact(id, (record) => {
      if (!record || !sameHandoffAgent(record.from, sender)) throw new Error('Only the sender can cancel.');
      this.requireReceiver(record);
      return transitionHandoff(record, {
        operationId, at: Math.max(this.now(), record.updatedAt), by: { kind: 'agent', address: sender },
        state: 'cancelled', ...(reason !== undefined && { reason }),
      }, expectedVersion);
    });
  }

  /** Internal worker boundary: never exposed as an agent tool. */
  async advance(id: string, update: AdvanceInput, expectedVersion: number): Promise<Handoff> {
    let revoked = false;
    const result = await this.options.store.transact(id, async (record) => {
      if (!record) throw new Error('Handoff does not exist.');
      this.requireReceiver(record);
      if (record.version !== expectedVersion) throw new Error('Handoff version conflict.');
      if (!record.acceptance || isTerminalHandoff(record.state)) throw new Error('Handoff has no active agreement.');
      const senderAllowed = await this.options.authorize({ action: 'handoff.offer', actor: record.from, record, stage: update.state });
      const receiverAllowed = await this.options.authorize({ action: 'handoff.accept', actor: record.acceptance.by, record, stage: update.state });
      revoked = !senderAllowed || !receiverAllowed;
      return transitionHandoff(record, {
        ...(revoked ? { state: 'failed' as const, failure: { step: 'authorization' as const, code: 'authorization_changed' as const } } : update),
        operationId: this.newId(), at: Math.max(this.now(), record.updatedAt),
        by: { kind: 'machine', machine: this.options.machine },
      }, expectedVersion);
    });
    if (revoked) throw new Error('Handoff authorization changed; the handoff has failed.');
    return result;
  }

  /** Only the receiver can send authoritative history back to the sender. */
  async receiveSnapshot(raw: unknown, authenticatedMachine: string): Promise<Handoff> {
    const next = parseHandoff(raw);
    if (next.from.machine !== this.options.machine || next.to.machine !== authenticatedMachine
      || authenticatedMachine === this.options.machine) throw new Error('Invalid handoff snapshot source.');
    return this.options.store.transact(next.id, (current) => {
      if (!current) throw new Error('Handoff offer is unknown.');
      if (next.version < current.version) {
        assertHandoffExtension(next, current);
        return current;
      }
      assertHandoffExtension(current, next);
      return next;
    });
  }

  /** No replay of an uncertain filesystem mutation after a restart. */
  async recover(): Promise<Handoff[]> {
    const recovered: Handoff[] = [];
    for (const record of this.options.store.list()) {
      if (record.to.machine !== this.options.machine || record.state !== 'applying') continue;
      recovered.push(await this.options.store.transact(record.id, (current) => {
        if (!current || current.state !== 'applying') throw new Error('Handoff changed during recovery.');
        return transitionHandoff(current, {
          operationId: this.newId(), at: Math.max(this.now(), current.updatedAt),
          by: { kind: 'machine', machine: this.options.machine }, state: 'failed',
          failure: { step: 'recovery', code: 'indeterminate_apply' },
        }, current.version);
      }));
    }
    return recovered;
  }
}
