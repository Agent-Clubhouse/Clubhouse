/** Main-only unwired journal owner. No driver, runtime generation or UI publisher. */
import { randomUUID } from 'crypto';
import { NoticeFramedJournal, NoticeLedgerValidationError, type NoticePhysicalCodec, type NoticePhysicalFailurePoint } from './framed-journal';
import { legacyNoticeCodec } from './legacy-codec';
import { sparseRootCodec, noticeHeaderDigest, type NoticeRootInput, type NoticeRootRecord, type NoticeRootState } from './root-codec';
import { noticeCoverageDigest, noticeRecipientKey, type NoticeAttempt, type NoticeDelta, type NoticeRecipient, type SequencedNoticeState } from './state';
import type { PreparedNoticeRoots } from './sparse-reader';

const handoffBrand = Symbol('notice-live-handoff');
export interface NoticeLiveHandoff { readonly [handoffBrand]: true }
/** Ledger-domain shape; actual RuntimeAttemptHooks assignment is a composition check. */
export type NoticeLossClaim = { kind: 'journal_owned' }
  | { kind: 'claimed'; committed: Promise<{ committedOutcome: 'unsubmitted' | 'uncertain' }> };
export type NoticeOwnerDelta = Exclude<NoticeDelta, { kind: 'recover' }>;
type OwnerDelta = NoticeOwnerDelta | { kind: 'recover'; attemptIds: string[] };
interface Anchor {
  attemptId: string;
  digest: string;
  entered: boolean;
  epoch: number;
  status: 'active' | 'uncertain' | 'settled' | 'recovered';
}
interface Proof { anchor: Anchor; epoch: number; entered: boolean; consumed: boolean; blocked: boolean }
interface Claim { kind: 'settle' | 'loss' | 'ack'; anchor?: Anchor; done?: Promise<unknown> }
interface Strategy<S, D, R, V> {
  codec: NoticePhysicalCodec<S, D, R>;
  input(state: S | undefined, delta: OwnerDelta): D;
  delta(input: D): OwnerDelta;
  attempt(state: S | undefined, id: string): Promise<NoticeAttempt | undefined>;
  active(state: S | undefined): Promise<{ ids: string[]; count: number }>;
  view(state: S): V;
}
export interface NoticeJournalOptions {
  directory: string;
  recipient: NoticeRecipient;
  installationId?: string;
  testFailure?: (point: NoticePhysicalFailurePoint) => void | Promise<void>;
}
const clone = <T>(v: T): T => structuredClone(v);
function invalid(message: string): never { throw new NoticeLedgerValidationError(message); }

/** One shared capability/claim implementation for both physical codecs. */
export class NoticeJournalOwner<S, D, R, V> {
  private backend!: NoticeFramedJournal<S, D, R>;
  private readonly processId = randomUUID();
  /** Strong anchors only for active same-process attempts; never all historical rows. */
  private readonly anchors = new Map<string, Anchor>();
  private readonly proofs = new WeakMap<NoticeLiveHandoff, Proof>();
  /** Only pending producers, including ACK, synchronously fence entry. */
  private readonly claims = new Map<string, Claim>();
  private ready = false;
  private retired = false;
  private recovering = false;
  private recovery?: Promise<void>;
  private constructor(private readonly strategy: Strategy<S, D, R, V>) {}

  static async openLegacy(options: NoticeJournalOptions) {
    const recipient = clone(options.recipient);
    const strategy: Strategy<SequencedNoticeState, NoticeDelta, NoticeDelta, SequencedNoticeState> = {
      codec: legacyNoticeCodec(recipient),
      input: (_state, delta) => delta.kind === 'recover' ? { kind: 'recover' } : delta,
      delta: (input) => input.kind === 'recover' ? { kind: 'recover', attemptIds: [] } : input,
      attempt: async (state, id) => clone(state?.attempts.find((a) => a.attemptId === id)),
      active: async (state) => {
        const active = state?.attempts.filter((a) => a.status !== 'uncertain') ?? [];
        return { ids: active.slice(0, 50).map((a) => a.attemptId), count: active.length };
      },
      view: clone,
    };
    return NoticeJournalOwner.open(options, strategy);
  }
  static async openSparse(options: NoticeJournalOptions) {
    const strategy: Strategy<NoticeRootState, NoticeRootInput, NoticeRootRecord, PreparedNoticeRoots> = {
      codec: sparseRootCodec(options.directory, clone(options.recipient)),
      input: (state, delta) => ({ expectedHeaderDigest: state ? noticeHeaderDigest(state.header) : null,
        delta: delta.kind === 'recover' ? { kind: 'recover', attemptIds: delta.attemptIds } : delta as NoticeRootInput['delta'] }),
      delta: (input) => input.delta as OwnerDelta,
      attempt: async (state, id) => state?.prepared?.lookupAttempt(id),
      active: async (state) => ({ ids: state?.prepared ? (await state.prepared.listActive({ limit: 50 })).attemptIds : [], count: state?.header.roots.active?.count ?? 0 }),
      view: (state) => clone(state.header),
    };
    return NoticeJournalOwner.open(options, strategy);
  }
  private static async open<S, D, R, V>(options: NoticeJournalOptions, strategy: Strategy<S, D, R, V>): Promise<NoticeJournalOwner<S, D, R, V>> {
    const owner = new NoticeJournalOwner(strategy);
    owner.backend = await NoticeFramedJournal.open({ directory: options.directory, recipientKey: noticeRecipientKey(options.recipient),
      installationId: options.installationId, codec: strategy.codec, testFailure: options.testFailure,
      published: (_state, _record, input) => owner.published(strategy.delta(input)) });
    try { await owner.recover(); return owner; }
    catch (error) { await owner.backend.close(); throw error; }
  }
  get healthy(): boolean { return this.backend.healthy; }
  get admitting(): boolean { return this.ready && !this.retired && !this.recovering && this.backend.healthy; }
  get committedRevision(): number { return this.backend.committedRevision; }
  get committedDigest(): string { return this.backend.committedDigest; }
  get committedPosition() { return this.backend.committedPosition; }
  /** Active anchors plus pending producers; weak historical capabilities are caller-lived. */
  get retention() { return { activeAnchors: this.anchors.size, pendingClaims: this.claims.size }; }
  snapshot(): V | undefined { return this.backend.current ? this.strategy.view(this.backend.current) : undefined; }
  checkpoint(): Promise<void> { return this.backend.checkpoint(); }
  private admission(): void {
    if (!this.ready || this.retired || this.recovering || !this.backend.healthy) invalid('Notice journal admission is unavailable');
  }
  private bump(anchor: Anchor): void {
    if (!Number.isSafeInteger(anchor.epoch + 1)) this.backend.refuseReconciliation('Notice capability epoch exhausted');
    anchor.epoch++;
  }
  private published(delta: OwnerDelta): void {
    if (delta.kind === 'intent') {
      this.anchors.set(delta.attemptId, { attemptId: delta.attemptId, digest: noticeCoverageDigest(delta.posts), entered: false, epoch: 0, status: 'active' });
    } else if (delta.kind === 'settle') {
      const anchor = this.claims.get(delta.attemptId)?.anchor ?? this.anchors.get(delta.attemptId);
      if (anchor) { anchor.status = delta.outcome === 'uncertain' ? 'uncertain' : 'settled'; this.bump(anchor); }
      this.anchors.delete(delta.attemptId);
    } else if (delta.kind === 'recover') {
      // Legacy codec's single recovery delta covers all its active rows.
      const ids = delta.attemptIds.length ? delta.attemptIds : [...this.anchors.keys()];
      for (const id of ids) {
        const anchor = this.anchors.get(id) ?? this.claims.get(id)?.anchor;
        if (anchor) { anchor.status = 'recovered'; this.bump(anchor); }
        this.anchors.delete(id);
      }
    }
  }
  private beginClaim(id: string, claim: Claim): void {
    if (this.claims.has(id)) invalid('Notice attempt is journal owned');
    if (claim.anchor) this.bump(claim.anchor);
    this.claims.set(id, claim);
  }
  private finishClaim(id: string, claim: Claim, failure?: { error: unknown }): void {
    // Validation with no authority effect can release. Unknown IO already
    // poisons the backend; keep the failed owner visible until explicit close.
    if (failure && !(failure.error instanceof NoticeLedgerValidationError)) return;
    if (this.claims.get(id) === claim) this.claims.delete(id);
  }
  append(input: NoticeOwnerDelta): Promise<V | undefined> {
    this.admission(); const owned = clone(input);
    if (!['initialize', 'scan', 'intent', 'queued', 'settle'].includes(owned.kind)) invalid('Use complete journal recovery, not a raw recovery delta');
    if (owned.kind === 'settle' && owned.outcome === 'accepted') invalid('Use exact live acknowledgement capability');
    if (owned.kind === 'intent') owned.handoffProcess = this.processId;
    const id = owned.kind === 'settle' ? owned.attemptId : undefined;
    const claim: Claim | undefined = id ? { kind: 'settle', anchor: this.anchors.get(id) } : undefined;
    if (id && claim) this.beginClaim(id, claim);
    const task = this.backend.commitFrom((state) => {
      let delta = owned;
      if (delta.kind === 'settle' && delta.outcome === 'unsubmitted' && claim?.anchor?.entered) delta = { ...delta, outcome: 'uncertain' };
      return this.strategy.input(state, delta);
    }).then(() => {
      if (id && claim) this.finishClaim(id, claim);
      return this.snapshot();
    }, (error: unknown) => {
      if (id && claim) this.finishClaim(id, claim, { error });
      throw error; // telemetry-exempt: caller owns visible settlement/storage failure
    });
    if (claim) claim.done = task;
    return task;
  }
  captureLiveHandoff(attemptId: string): Promise<NoticeLiveHandoff> {
    this.admission();
    return this.backend.inspect(async (state) => {
      const attempt = await this.strategy.attempt(state, attemptId);
      this.admission();
      if (!attempt || attempt.status === 'uncertain' || attempt.handoffProcess !== this.processId || this.claims.has(attemptId)) invalid('No exact live notice handoff');
      let anchor = this.anchors.get(attemptId);
      if (!anchor) {
        anchor = { attemptId, digest: attempt.coverageDigest, entered: false, epoch: 0, status: 'active' };
        this.anchors.set(attemptId, anchor);
      }
      if (anchor.entered || anchor.status !== 'active' || anchor.digest !== attempt.coverageDigest) invalid('No exact live notice handoff');
      const handle: NoticeLiveHandoff = Object.freeze({ [handoffBrand]: true as const });
      this.proofs.set(handle, { anchor, epoch: anchor.epoch, entered: false, consumed: false, blocked: false });
      return handle;
    });
  }
  tryMarkHandoffEntered(handle: NoticeLiveHandoff): 'entered' | 'journal_owned' {
    const proof = this.proofs.get(handle); const anchor = proof?.anchor;
    if (!proof || !anchor || proof.blocked || proof.consumed || !this.ready || this.retired || this.recovering || !this.backend.healthy
      || this.claims.has(anchor.attemptId) || anchor.status !== 'active' || anchor.entered || proof.epoch !== anchor.epoch) {
      if (proof) proof.blocked = true;
      return 'journal_owned';
    }
    anchor.entered = true; proof.entered = true;
    return 'entered';
  }
  releaseLiveHandoff(handle: NoticeLiveHandoff): void { this.proofs.delete(handle); }
  claimLoss(handle: NoticeLiveHandoff, requested: 'unsubmitted' | 'unknown'): NoticeLossClaim {
    if (requested !== 'unsubmitted' && requested !== 'unknown') invalid('Unsupported runtime loss disposition');
    const proof = this.proofs.get(handle); const anchor = proof?.anchor;
    if (!proof || !anchor || proof.blocked || proof.consumed || anchor.status !== 'active' || proof.epoch !== anchor.epoch || this.claims.has(anchor.attemptId)
      || this.recovering || !this.backend.healthy) return { kind: 'journal_owned' };
    return this.claimAnchorLoss(anchor, requested);
  }
  private claimAnchorLoss(anchor: Anchor, requested: 'unsubmitted' | 'unknown'): NoticeLossClaim {
    if (this.claims.has(anchor.attemptId)) return { kind: 'journal_owned' };
    const claim: Claim = { kind: 'loss', anchor }; this.beginClaim(anchor.attemptId, claim);
    let disposition: 'unsubmitted' | 'uncertain' | undefined;
    const task = this.backend.commitFrom(async (state) => {
      const attempt = await this.strategy.attempt(state, anchor.attemptId);
      if (!attempt || attempt.coverageDigest !== anchor.digest || attempt.handoffProcess !== this.processId || attempt.status === 'uncertain') invalid('Loss claim no longer has exact active coverage');
      disposition = requested === 'unknown' || anchor.entered ? 'uncertain' : 'unsubmitted';
      return this.strategy.input(state, { kind: 'settle', attemptId: anchor.attemptId, outcome: disposition });
    }).then((result) => {
      if (!result.changed || !disposition) this.backend.refuseReconciliation('Claimed loss did not commit its exact disposition');
      this.finishClaim(anchor.attemptId, claim);
      return { committedOutcome: disposition };
    }, (error: unknown) => {
      this.finishClaim(anchor.attemptId, claim, { error }); throw error; // telemetry-exempt: coordinator retains the failed persistence promise
    });
    claim.done = task;
    return { kind: 'claimed', committed: task };
  }
  /** Main historical sink only. No current runtime/UI/member publisher is retained. */
  acknowledgeLiveHandoff(handle: NoticeLiveHandoff): Promise<V | undefined> {
    const proof = this.proofs.get(handle); const anchor = proof?.anchor;
    if (!proof || !anchor || !proof.entered || !anchor.entered || anchor.status === 'recovered' || this.recovering || !this.backend.healthy) return Promise.reject(new NoticeLedgerValidationError('No genuine entered historical handoff'));
    if (proof.consumed || anchor.status === 'settled') return Promise.resolve(this.snapshot());
    const prior = this.claims.get(anchor.attemptId);
    if (prior?.kind === 'ack') return prior.done!.then(() => this.snapshot());
    const claim: Claim = { kind: 'ack', anchor };
    // ACK joins the synchronous registry NOW, including when it follows a loss
    // already queued. The earlier producer cannot remove this newer ACK fence.
    this.bump(anchor); this.claims.set(anchor.attemptId, claim);
    const task = this.backend.commitFrom(async (state) => {
      const attempt = await this.strategy.attempt(state, anchor.attemptId);
      if (!attempt || attempt.reason === 'recovered' || attempt.coverageDigest !== anchor.digest || attempt.handoffProcess !== this.processId) invalid('Historical acknowledgement has no exact live provenance');
      return this.strategy.input(state, { kind: 'settle', attemptId: anchor.attemptId, outcome: 'accepted',
        acknowledgement: { kind: 'same-process-exact-handoff', handoffProcess: this.processId, coverageDigest: anchor.digest } });
    }).then((result) => {
      if (!result.changed) this.backend.refuseReconciliation('Historical acknowledgement did not commit exact coverage');
      proof.consumed = true; this.finishClaim(anchor.attemptId, claim); return this.snapshot();
    }, (error: unknown) => {
      this.finishClaim(anchor.attemptId, claim, { error }); throw error; // telemetry-exempt: historical sink owns visible reconciliation failure
    });
    claim.done = task; return task;
  }
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.ready = false; this.recovering = true;
    const task = this.walkRecovery().then(() => {
      this.recovering = false; this.ready = !this.retired;
    }, (error: unknown) => {
      this.recovering = false; this.ready = false; throw error; // telemetry-exempt: opener/caller owns typed reconciliation failure
    });
    this.recovery = task;
    void task.then(() => { this.recovery = undefined; }, () => { this.recovery = undefined; });
    return task;
  }
  private async walkRecovery(): Promise<void> {
    while (true) {
      const before = await this.backend.inspect((state) => this.strategy.active(state));
      if (!before.count) return;
      if (!before.ids.length || before.ids.length > 50) this.backend.refuseReconciliation('Recovery active selection cannot make progress');
      const result = await this.backend.commitFrom((state) => this.strategy.input(state, { kind: 'recover', attemptIds: before.ids }));
      const after = await this.backend.inspect((state) => this.strategy.active(state));
      if (!result.changed || after.count >= before.count || after.ids.some((id) => before.ids.includes(id))) this.backend.refuseReconciliation('Recovery did not shrink exact active coverage');
    }
  }
  /** Closes this ledger owner's admission, not a runtime generation or durable member adoption. */
  async retire(): Promise<void> {
    this.ready = false; this.retired = true;
    const pending = new Set<Promise<unknown>>();
    for (const claim of this.claims.values()) if (claim.done) pending.add(claim.done);
    for (const anchor of this.anchors.values()) {
      const existing = this.claims.get(anchor.attemptId);
      if (existing?.done) pending.add(existing.done);
      else {
        const claim = this.claimAnchorLoss(anchor, 'unknown');
        if (claim.kind === 'claimed') pending.add(claim.committed);
      }
    }
    await Promise.all(pending);
    if (this.anchors.size) this.backend.refuseReconciliation('Retired owner still retains active capability anchors');
  }
  /** Caller waits for bounded historical sources before final physical close. */
  async close(): Promise<void> {
    try { if (this.backend.healthy) await this.retire(); }
    finally {
      try { await this.backend.close(); }
      finally { this.anchors.clear(); this.claims.clear(); }
    }
  }
}
