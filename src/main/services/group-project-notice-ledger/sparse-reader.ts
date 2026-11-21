/** Prepared immutable sequenced roots only: no journal commit or send authority. */
import { NoticePageIndex, type NoticePageEntry, type NoticePageRoot } from './pages';
import { noticeSequence, type NoticeInterval } from './intervals';
import { NOTICE_BATCH_LIMIT, noticeCoverageDigest, noticeRecipientKey, type NoticeAttempt, type NoticeRecipient, type PendingNoticePost } from './state';

export interface PreparedNoticeRoots {
  schemaVersion: 1;
  minWriterVersion: 2;
  profile: 'sequenced-sparse-v1';
  recipient: NoticeRecipient;
  baselineThrough: number;
  scannedThrough: number;
  acceptedCount: number;
  excludedSequenceCount: number;
  lateAcknowledgementCount: number;
  roots: Partial<Record<'terminal' | 'pending' | 'ready' | 'attempts' | 'active' | 'postIds', NoticePageRoot>>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rootNames = ['terminal', 'pending', 'ready', 'attempts', 'active', 'postIds'] as const;
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid sparse notice identity');
}
/** Numeric sequence ordering only; never used to infer ordering from post IDs. */
export function noticeSequenceKey(value: number): string { return String(noticeSequence(value)).padStart(16, '0'); }
function sequenceKey(key: string): number {
  const value = Number(key);
  if (noticeSequenceKey(value) !== key) throw new Error('Noncanonical sparse notice sequence key');
  return value;
}
function pendingRow(entry: NoticePageEntry): PendingNoticePost {
  const value = entry.value;
  if (!object(value) || value.seq !== sequenceKey(entry.key)) throw new Error('Sparse notice pending key mismatch');
  id(value.postId);
  if (value.attemptId !== undefined) id(value.attemptId);
  return clone(value) as unknown as PendingNoticePost;
}
function attemptRow(entry: NoticePageEntry): NoticeAttempt {
  const value = entry.value;
  if (!object(value) || value.attemptId !== entry.key || !['intent', 'queued', 'uncertain'].includes(value.status as string)
    || !Array.isArray(value.posts) || !value.posts.length || value.posts.length > NOTICE_BATCH_LIMIT
    || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) || value.startedAt < 0) throw new Error('Invalid sparse notice attempt');
  id(value.attemptId); id(value.handoffProcess);
  if (value.messageId !== undefined) id(value.messageId);
  if (value.reason !== undefined && (value.status !== 'uncertain' || !['recovered', 'handoff_unknown'].includes(value.reason as string))) throw new Error('Invalid sparse notice uncertainty reason');
  const seqs = new Set<number>(); const ids = new Set<string>();
  for (const post of value.posts) {
    if (!object(post)) throw new Error('Invalid sparse notice attempt post');
    const seq = noticeSequence(post.seq as number); id(post.postId);
    if (seqs.has(seq) || ids.has(post.postId)) throw new Error('Duplicate sparse notice attempt coverage');
    seqs.add(seq); ids.add(post.postId);
  }
  if (noticeCoverageDigest(value.posts as unknown as NoticeAttempt['posts']) !== value.coverageDigest) throw new Error('Sparse notice attempt digest mismatch');
  return clone(value) as unknown as NoticeAttempt;
}

/**
 * Read-only prepared snapshot. Even successful verification does not authenticate
 * a root as committed, migrate a generation, consume a nonce, or permit a send.
 * The future journal/catalog owner must supply that independent authority.
 */
export class PreparedNoticeReader {
  private constructor(private readonly index: NoticePageIndex, private readonly header: PreparedNoticeRoots) {}
  static async openPrepared(index: NoticePageIndex, value: unknown): Promise<PreparedNoticeReader> {
    if (!object(value) || value.schemaVersion !== 1 || value.minWriterVersion !== 2 || value.profile !== 'sequenced-sparse-v1'
      || !object(value.recipient) || !object(value.roots) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new Error('Unsupported sparse notice header');
    noticeRecipientKey(value.recipient as unknown as NoticeRecipient);
    for (const field of ['baselineThrough', 'scannedThrough', 'acceptedCount', 'excludedSequenceCount', 'lateAcknowledgementCount']) noticeSequence(value[field] as number);
    if ((value.baselineThrough as number) > (value.scannedThrough as number) || Object.keys(value.roots).some((name) => !rootNames.includes(name as typeof rootNames[number]))) throw new Error('Invalid sparse notice frontier or roots');
    const reader = new PreparedNoticeReader(index, clone(value) as unknown as PreparedNoticeRoots);
    await reader.verify();
    return reader;
  }
  get preparedHeader(): PreparedNoticeRoots { return clone(this.header); }
  /** Bounded batches, not an all-record snapshot. Cursors belong to this root. */
  private async *rows(root: NoticePageRoot | undefined): AsyncGenerator<NoticePageEntry> {
    let after: string | undefined;
    while (true) {
      const page = await this.index.list(root, { after, limit: 16 });
      for (const row of page.entries) yield row;
      if (!page.nextAfter) return;
      after = page.nextAfter;
    }
  }
  private async pending(seq: number): Promise<PendingNoticePost | undefined> {
    const key = noticeSequenceKey(seq);
    const value = await this.index.get(this.header.roots.pending, key);
    return value === undefined ? undefined : pendingRow({ key, value });
  }
  async attempt(attemptId: string): Promise<NoticeAttempt | undefined> {
    id(attemptId);
    const value = await this.index.get(this.header.roots.attempts, attemptId);
    return value === undefined ? undefined : attemptRow({ key: attemptId, value });
  }
  async listReady(options: { after?: string; limit: number }): Promise<{ posts: PendingNoticePost[]; nextAfter?: string }> {
    this.limit(options.limit);
    const page = await this.index.list(this.header.roots.ready, options);
    const posts: PendingNoticePost[] = [];
    for (const row of page.entries) {
      const pending = await this.pending(sequenceKey(row.key));
      if (!pending || pending.attemptId !== undefined || pending.postId !== row.value) throw new Error('Sparse notice ready reference mismatch');
      posts.push(pending);
    }
    return { posts, ...(page.nextAfter ? { nextAfter: page.nextAfter } : {}) };
  }
  async listAttempts(options: { after?: string; limit: number; activeOnly?: boolean }): Promise<{ attempts: NoticeAttempt[]; nextAfter?: string }> {
    this.limit(options.limit);
    const page = await this.index.list(options.activeOnly ? this.header.roots.active : this.header.roots.attempts, options);
    const attempts: NoticeAttempt[] = [];
    for (const row of page.entries) {
      const attempt = options.activeOnly ? await this.attempt(row.key) : attemptRow(row);
      if (!attempt || options.activeOnly && (row.value !== true || attempt.status === 'uncertain')) throw new Error('Sparse notice active reference mismatch');
      attempts.push(attempt);
    }
    return { attempts, ...(page.nextAfter ? { nextAfter: page.nextAfter } : {}) };
  }
  async legacyFloor(): Promise<number> {
    if (this.header.baselineThrough === this.header.scannedThrough) return this.header.baselineThrough;
    const first = this.header.baselineThrough + 1;
    const row = await this.index.atOrBefore(this.header.roots.terminal, noticeSequenceKey(first));
    if (!row) return this.header.baselineThrough;
    const range = this.range(row);
    return range[0] <= first && range[1] >= first ? range[1] : this.header.baselineThrough;
  }
  private limit(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > NOTICE_BATCH_LIMIT) throw new Error('Invalid sparse notice read limit');
  }
  private range(row: NoticePageEntry): NoticeInterval {
    if (!Array.isArray(row.value) || row.value.length !== 2) throw new Error('Invalid sparse notice terminal interval');
    const lo = noticeSequence(row.value[0] as number); const hi = noticeSequence(row.value[1] as number);
    if (lo !== sequenceKey(row.key) || hi < lo) throw new Error('Sparse notice terminal key mismatch');
    return [lo, hi];
  }
  private async verify(): Promise<void> {
    const { roots } = this.header;
    for (const name of rootNames) await this.index.verify(roots[name]);
    const terminal = this.rows(roots.terminal); const pending = this.rows(roots.pending);
    let t = await terminal.next(); let p = await pending.next();
    let floor = this.header.baselineThrough; let terminalCount = 0; let priorTerminalEnd: number | undefined;
    // Merge coverage spans, not every position in a large excluded range.
    while (!t.done || !p.done) {
      const range = t.done ? undefined : this.range(t.value);
      const post = p.done ? undefined : pendingRow(p.value);
      let lo: number; let hi: number;
      if (range && (!post || range[0] <= post.seq)) {
        [lo, hi] = range;
        if (priorTerminalEnd !== undefined && lo - priorTerminalEnd <= 1) throw new Error('Noncanonical sparse notice intervals');
        priorTerminalEnd = hi; terminalCount += hi - lo + 1;
        t = await terminal.next();
      } else {
        lo = hi = post!.seq;
        await this.verifyPending(post!);
        p = await pending.next();
      }
      if (lo - floor !== 1 || hi > this.header.scannedThrough) throw new Error('Sparse notice coverage gap or overlap');
      floor = hi;
    }
    if (floor !== this.header.scannedThrough || this.header.acceptedCount + this.header.excludedSequenceCount !== terminalCount) throw new Error('Sparse notice coverage or terminal count mismatch');
    for await (const row of this.rows(roots.ready)) {
      const post = await this.pending(sequenceKey(row.key));
      if (!post || post.attemptId !== undefined || post.postId !== row.value) throw new Error('Orphan sparse notice ready row');
    }
    for await (const row of this.rows(roots.postIds)) {
      id(row.key); const post = await this.pending(noticeSequence(row.value as number));
      if (!post || post.postId !== row.key) throw new Error('Orphan sparse notice post ID');
    }
    for await (const row of this.rows(roots.attempts)) {
      const attempt = attemptRow(row);
      for (const covered of attempt.posts) {
        const post = await this.pending(covered.seq);
        if (!post || post.postId !== covered.postId || post.attemptId !== attempt.attemptId) throw new Error('Sparse notice attempt coverage mismatch');
      }
      const active = await this.index.get(roots.active, attempt.attemptId);
      if (attempt.status === 'uncertain' ? active !== undefined : active !== true) throw new Error('Sparse notice active coverage mismatch');
    }
    for await (const row of this.rows(roots.active)) {
      const attempt = await this.attempt(row.key);
      if (row.value !== true || !attempt || attempt.status === 'uncertain') throw new Error('Orphan sparse notice active attempt');
    }
  }
  private async verifyPending(post: PendingNoticePost): Promise<void> {
    const { roots } = this.header;
    if (await this.index.get(roots.postIds, post.postId) !== post.seq) throw new Error('Sparse notice post ID reference mismatch');
    const ready = await this.index.get(roots.ready, noticeSequenceKey(post.seq));
    if (post.attemptId === undefined) {
      if (ready !== post.postId) throw new Error('Sparse notice ready reference mismatch');
    } else {
      const attempt = await this.attempt(post.attemptId);
      if (ready !== undefined || !attempt?.posts.some((p) => p.seq === post.seq && p.postId === post.postId)) throw new Error('Sparse notice pending ownership mismatch');
    }
  }
}
