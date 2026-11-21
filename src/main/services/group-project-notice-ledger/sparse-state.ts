/** Prepared root transitions only. No committed revision, receipt or send authority. */
import { NoticePageIndex, type NoticeJson, type NoticePageEntry } from './pages';
import { noticeSequence } from './intervals';
import { NoticeLedgerValidationError } from './validation';
import { noticeSequenceKey, PreparedNoticeReader, type PreparedNoticeRoots } from './sparse-reader';
import { NOTICE_BATCH_LIMIT, noticeCoverageDigest, noticeRecipientKey, type NoticeAttempt, type NoticeDelta, type NoticePost, type NoticeRecipient, type PendingNoticePost } from './state';

/** Recovery must be walked/committed in bounded batches by the future journal owner. */
export type SparseNoticeDelta = Exclude<NoticeDelta, { kind: 'initialize' } | { kind: 'recover' }>
  | { kind: 'recover'; attemptIds: string[] };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new NoticeLedgerValidationError('Invalid sparse notice identity');
}
function keys(value: object, required: string[], optional: string[] = []): void {
  if (required.some((k) => !Object.prototype.hasOwnProperty.call(value, k)) || Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))) throw new NoticeLedgerValidationError('Unsupported sparse notice fields');
}
function post(value: NoticePost): NoticePost {
  keys(value, ['seq', 'postId']); noticeSequence(value.seq); id(value.postId);
  return { seq: value.seq, postId: value.postId };
}
function json(value: object): NoticeJson { return copy(value) as unknown as NoticeJson; }
function boundedList(values: readonly unknown[]): void {
  if (!Array.isArray(values) || values.length > NOTICE_BATCH_LIMIT) throw new NoticeLedgerValidationError('Sparse notice batch too large');
}

/**
 * An immutable, uncommitted root set. prepare() owns its input before yielding,
 * writes only copy-on-write orphan pages, and never publishes over this object.
 * The future single journal queue must bind expected revision/recipient, earn
 * all authoritative root barriers, append/sync, and only then expose a result.
 * This reducer does not replace the reviewed live receipt/entry arbitration.
 */
export class PreparedNoticeState {
  private constructor(private readonly index: NoticePageIndex, private readonly header: PreparedNoticeRoots) {}
  static initialize(index: NoticePageIndex, recipient: NoticeRecipient, baseline: number): PreparedNoticeState {
    keys(recipient, ['groupId', 'host', 'agentId', 'generation']); noticeRecipientKey(recipient); noticeSequence(baseline);
    return new PreparedNoticeState(index, { schemaVersion: 1, minWriterVersion: 2, profile: 'sequenced-sparse-v1', recipient: copy(recipient),
      baselineThrough: baseline, scannedThrough: baseline, acceptedCount: 0, excludedSequenceCount: 0, lateAcknowledgementCount: 0, roots: {} });
  }
  /** Full streaming consistency verification at an untrusted storage boundary. */
  static async openPrepared(index: NoticePageIndex, value: unknown): Promise<PreparedNoticeState> {
    const reader = await PreparedNoticeReader.openPrepared(index, value);
    return new PreparedNoticeState(index, reader.preparedHeader);
  }
  get preparedHeader(): PreparedNoticeRoots { return copy(this.header); }
  private async pending(seq: number): Promise<PendingNoticePost | undefined> {
    return await this.index.get(this.header.roots.pending, noticeSequenceKey(seq)) as unknown as PendingNoticePost | undefined;
  }
  private async attempt(attemptId: string): Promise<NoticeAttempt | undefined> {
    return await this.index.get(this.header.roots.attempts, attemptId) as unknown as NoticeAttempt | undefined;
  }
  /** Only new frontier spans or single accepted positions may be covered. */
  private async cover(header: PreparedNoticeRoots, lo: number, hi = lo): Promise<void> {
    let root = header.roots.terminal;
    const previous = await this.index.atOrBefore(root, noticeSequenceKey(lo));
    if (previous) {
      const range = previous.value as number[];
      if (lo - range[1] <= 1) { lo = range[0]; hi = Math.max(hi, range[1]); root = await this.index.delete(root, previous.key); }
    }
    // A canonical existing interval set has at most one successor adjoining a
    // single accepted position. A new scan range lies beyond the old frontier.
    const next = (await this.index.list(root, { after: noticeSequenceKey(lo), limit: 1 })).entries[0];
    if (next) {
      const range = next.value as number[];
      if (range[0] - hi <= 1) { hi = Math.max(hi, range[1]); root = await this.index.delete(root, next.key); }
    }
    header.roots.terminal = await this.index.set(root, noticeSequenceKey(lo), [lo, hi]);
  }
  private async putAttempt(header: PreparedNoticeRoots, attempt: NoticeAttempt): Promise<void> {
    header.roots.attempts = await this.index.set(header.roots.attempts, attempt.attemptId, json(attempt));
  }
  async prepare(input: SparseNoticeDelta): Promise<PreparedNoticeState> {
    // Synchronous ownership before the first index operation/await. In particular
    // a caller cannot change coverage/settlement while preparation is suspended.
    const delta = structuredClone(input);
    const header = this.preparedHeader;
    switch (delta.kind) {
      case 'scan': {
        keys(delta, ['kind', 'through', 'eligible']); const through = noticeSequence(delta.through);
        boundedList(delta.eligible);
        const eligible = delta.eligible.map(post).sort((a, b) => a.seq - b.seq);
        if (eligible.length === NOTICE_BATCH_LIMIT && through !== eligible[eligible.length - 1].seq) throw new NoticeLedgerValidationError('Capped notice scan cannot over-advance its frontier');
        const seqs = new Set<number>(); const ids = new Set<string>();
        for (const p of eligible) {
          if (p.seq > through || seqs.has(p.seq) || ids.has(p.postId)) throw new NoticeLedgerValidationError('Conflicting notice scan');
          seqs.add(p.seq); ids.add(p.postId);
          const old = await this.pending(p.seq); const oldSeq = await this.index.get(header.roots.postIds, p.postId);
          if (old && old.postId !== p.postId || oldSeq !== undefined && oldSeq !== p.seq) throw new NoticeLedgerValidationError('Conflicting notice post identity');
        }
        if (through <= header.scannedThrough) return this;
        let cursor = header.scannedThrough;
        for (const p of eligible) if (p.seq > this.header.scannedThrough) {
          if (p.seq - cursor > 1) {
            await this.cover(header, cursor + 1, p.seq - 1);
            header.excludedSequenceCount = noticeSequence(header.excludedSequenceCount + (p.seq - cursor - 1));
          }
          header.roots.pending = await this.index.set(header.roots.pending, noticeSequenceKey(p.seq), json(p));
          header.roots.ready = await this.index.set(header.roots.ready, noticeSequenceKey(p.seq), p.postId);
          header.roots.postIds = await this.index.set(header.roots.postIds, p.postId, p.seq);
          cursor = p.seq;
        }
        if (cursor < through) {
          await this.cover(header, cursor + 1, through);
          header.excludedSequenceCount = noticeSequence(header.excludedSequenceCount + (through - cursor));
        }
        header.scannedThrough = through;
        break;
      }
      case 'intent': {
        keys(delta, ['kind', 'attemptId', 'posts', 'startedAt', 'handoffProcess']); id(delta.attemptId); id(delta.handoffProcess);
        boundedList(delta.posts);
        if (!delta.posts.length || !Number.isFinite(delta.startedAt) || delta.startedAt < 0) throw new NoticeLedgerValidationError('Invalid notice attempt');
        const posts = delta.posts.map(post).sort((a, b) => a.seq - b.seq);
        if (new Set(posts.map((p) => p.seq)).size !== posts.length || new Set(posts.map((p) => p.postId)).size !== posts.length) throw new NoticeLedgerValidationError('Duplicate attempt coverage');
        const coverageDigest = noticeCoverageDigest(posts); const existing = await this.attempt(delta.attemptId);
        if (existing) {
          if (existing.coverageDigest !== coverageDigest) throw new NoticeLedgerValidationError('Notice attempt key conflict');
          return this;
        }
        for (const p of posts) {
          const old = await this.pending(p.seq);
          if (!old || old.postId !== p.postId || old.attemptId !== undefined || await this.index.get(header.roots.ready, noticeSequenceKey(p.seq)) !== p.postId) throw new NoticeLedgerValidationError('Notice coverage is not ready');
        }
        for (const p of posts) {
          header.roots.pending = await this.index.set(header.roots.pending, noticeSequenceKey(p.seq), json({ ...p, attemptId: delta.attemptId }));
          header.roots.ready = await this.index.delete(header.roots.ready, noticeSequenceKey(p.seq));
        }
        await this.putAttempt(header, { attemptId: delta.attemptId, posts, coverageDigest, startedAt: delta.startedAt, handoffProcess: delta.handoffProcess, status: 'intent' });
        header.roots.active = await this.index.set(header.roots.active, delta.attemptId, true);
        break;
      }
      case 'queued': {
        keys(delta, ['kind', 'attemptId'], ['messageId']); id(delta.attemptId);
        if (delta.messageId !== undefined) id(delta.messageId);
        const old = await this.attempt(delta.attemptId);
        if (!old || old.status === 'uncertain') return this;
        if (old.messageId && delta.messageId && old.messageId !== delta.messageId) throw new NoticeLedgerValidationError('Notice runtime message conflict');
        if (old.status === 'queued' && old.messageId === delta.messageId) return this;
        await this.putAttempt(header, { ...old, status: 'queued', ...(delta.messageId !== undefined ? { messageId: delta.messageId } : {}) });
        break;
      }
      case 'settle': {
        keys(delta, ['kind', 'attemptId', 'outcome'], ['acknowledgement']); id(delta.attemptId);
        if (!['accepted', 'uncertain', 'unsubmitted'].includes(delta.outcome)) throw new NoticeLedgerValidationError('Unsupported notice settlement');
        const old = await this.attempt(delta.attemptId);
        if (!old) return this;
        if (delta.outcome === 'uncertain') {
          if (old.status === 'uncertain') return this;
          await this.putAttempt(header, { ...old, status: 'uncertain', reason: 'handoff_unknown' });
          header.roots.active = await this.index.delete(header.roots.active, old.attemptId);
          break;
        }
        if (delta.outcome === 'unsubmitted' && old.status === 'uncertain') throw new NoticeLedgerValidationError('Uncertainty cannot become proven unsubmitted');
        if (delta.outcome === 'accepted') {
          const proof = delta.acknowledgement;
          if (old.reason === 'recovered') throw new NoticeLedgerValidationError('Recovered notice cannot accept a live acknowledgement');
          if (!proof || proof.kind !== 'same-process-exact-handoff' || proof.handoffProcess !== old.handoffProcess || proof.coverageDigest !== old.coverageDigest) throw new NoticeLedgerValidationError('Notice acceptance requires exact live handoff provenance');
          keys(proof, ['kind', 'handoffProcess', 'coverageDigest']);
        }
        for (const p of old.posts) {
          const pending = await this.pending(p.seq);
          if (!pending || pending.postId !== p.postId || pending.attemptId !== old.attemptId) throw new Error('Notice attempt ownership changed');
          if (delta.outcome === 'accepted') {
            header.roots.pending = await this.index.delete(header.roots.pending, noticeSequenceKey(p.seq));
            header.roots.postIds = await this.index.delete(header.roots.postIds, p.postId);
            await this.cover(header, p.seq);
          } else {
            header.roots.pending = await this.index.set(header.roots.pending, noticeSequenceKey(p.seq), json(p));
            header.roots.ready = await this.index.set(header.roots.ready, noticeSequenceKey(p.seq), p.postId);
          }
        }
        header.roots.attempts = await this.index.delete(header.roots.attempts, old.attemptId);
        header.roots.active = await this.index.delete(header.roots.active, old.attemptId);
        if (delta.outcome === 'accepted') {
          header.acceptedCount = noticeSequence(header.acceptedCount + old.posts.length);
          if (old.status === 'uncertain') header.lateAcknowledgementCount = noticeSequence(header.lateAcknowledgementCount + 1);
        }
        break;
      }
      case 'recover': {
        keys(delta, ['kind', 'attemptIds']); boundedList(delta.attemptIds);
        if (new Set(delta.attemptIds).size !== delta.attemptIds.length) throw new NoticeLedgerValidationError('Duplicate recovery attempt');
        let changed = false;
        for (const attemptId of delta.attemptIds) {
          id(attemptId); const old = await this.attempt(attemptId);
          if (old && old.status !== 'uncertain') {
            await this.putAttempt(header, { ...old, status: 'uncertain', reason: 'recovered' });
            header.roots.active = await this.index.delete(header.roots.active, attemptId); changed = true;
          }
        }
        if (!changed) return this;
        break;
      }
      default: throw new NoticeLedgerValidationError('Unsupported sparse notice transition');
    }
    return new PreparedNoticeState(this.index, header);
  }
  /** Bounded read selection, never automatic handoff or a global ready snapshot. */
  async listReady(options: { after?: string; limit: number }): Promise<{ posts: PendingNoticePost[]; nextAfter?: string }> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > NOTICE_BATCH_LIMIT) throw new NoticeLedgerValidationError('Invalid sparse notice read limit');
    const page = await this.index.list(this.header.roots.ready, options);
    const posts: PendingNoticePost[] = [];
    for (const entry of page.entries) {
      const p = await this.pending(Number(entry.key));
      if (!p || p.attemptId !== undefined || p.postId !== entry.value) throw new Error('Sparse notice ready reference mismatch');
      posts.push(p);
    }
    return { posts, ...(page.nextAfter ? { nextAfter: page.nextAfter } : {}) };
  }
  async listActive(options: { after?: string; limit: number }): Promise<{ attemptIds: string[]; nextAfter?: string }> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > NOTICE_BATCH_LIMIT) throw new NoticeLedgerValidationError('Invalid sparse notice read limit');
    const page = await this.index.list(this.header.roots.active, options);
    return { attemptIds: page.entries.map((row: NoticePageEntry) => row.key), ...(page.nextAfter ? { nextAfter: page.nextAfter } : {}) };
  }
}
