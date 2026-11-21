import { createHash } from 'crypto';
import { contiguousNoticeFloor, coverNoticeInterval, noticeCovered, noticeSequence, validateNoticeIntervals, type NoticeInterval } from './intervals';

export const NOTICE_BATCH_LIMIT = 50;
export interface NoticeRecipient {
  groupId: string;
  host: string | null;
  agentId: string;
  generation: string;
}
export interface NoticePost { seq: number; postId: string }
export interface PendingNoticePost extends NoticePost { attemptId?: string }
export interface NoticeAttempt {
  attemptId: string;
  coverageDigest: string;
  posts: NoticePost[];
  startedAt: number;
  status: 'intent' | 'queued' | 'uncertain';
  /** Writer process that retained the original live handoff; not a runtime generation. */
  handoffProcess: string;
  reason?: 'recovered' | 'handoff_unknown';
  messageId?: string;
}
export interface SequencedNoticeState {
  schemaVersion: 1;
  minWriterVersion: 1;
  recipient: NoticeRecipient;
  baselineThrough: number;
  scannedThrough: number;
  terminal: NoticeInterval[];
  pending: PendingNoticePost[];
  attempts: NoticeAttempt[];
  acceptedCount: number;
  /** Counts sequence positions, including non-post board changes; never message count. */
  excludedSequenceCount: number;
  lateAcknowledgementCount: number;
}
export interface NoticeAcknowledgement {
  kind: 'same-process-exact-handoff';
  handoffProcess: string;
  coverageDigest: string;
}
export type NoticeDelta =
  | { kind: 'initialize'; recipient: NoticeRecipient; baseline: number }
  | { kind: 'scan'; through: number; eligible: NoticePost[] }
  | { kind: 'intent'; attemptId: string; posts: NoticePost[]; startedAt: number; handoffProcess?: string }
  | { kind: 'queued'; attemptId: string; messageId?: string }
  | { kind: 'settle'; attemptId: string; outcome: 'accepted' | 'uncertain' | 'unsubmitted'; acknowledgement?: NoticeAcknowledgement }
  | { kind: 'recover' };

function boundedId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid notice identity');
}
function recipientIdentity(recipient: NoticeRecipient): NoticeRecipient {
  boundedId(recipient.groupId); boundedId(recipient.agentId); boundedId(recipient.generation);
  if (recipient.host !== null) boundedId(recipient.host);
  return { ...recipient };
}
function postIdentity(post: NoticePost): NoticePost {
  noticeSequence(post.seq); boundedId(post.postId);
  return { ...post };
}
export function noticeCoverageDigest(posts: readonly NoticePost[]): string {
  return createHash('sha256').update(JSON.stringify([...posts].sort((a, b) => a.seq - b.seq).map((p) => [p.seq, p.postId]))).digest('hex');
}
export function noticeRecipientKey(recipient: NoticeRecipient): string {
  recipientIdentity(recipient);
  return createHash('sha256').update(JSON.stringify([recipient.groupId, recipient.host, recipient.agentId, recipient.generation])).digest('hex');
}
function initial(recipient: NoticeRecipient, baseline: number): SequencedNoticeState {
  noticeSequence(baseline);
  return { schemaVersion: 1, minWriterVersion: 1, recipient: recipientIdentity(recipient), baselineThrough: baseline,
    scannedThrough: baseline, terminal: [], pending: [], attempts: [], acceptedCount: 0, excludedSequenceCount: 0, lateAcknowledgementCount: 0 };
}

/** Internal pure reducer. No app lookup, runtime, dispatch, nonce or settings authority. */
export function applyNoticeDelta(current: SequencedNoticeState | undefined, delta: NoticeDelta): SequencedNoticeState {
  if (delta.kind === 'initialize') {
    if (current) throw new Error('Notice generation already initialized');
    return initial(delta.recipient, delta.baseline);
  }
  if (!current) throw new Error('Notice generation not initialized');
  const state: SequencedNoticeState = { ...current, terminal: [...current.terminal], pending: current.pending.map((p) => ({ ...p })), attempts: current.attempts.map((a) => ({ ...a, posts: a.posts.map((p) => ({ ...p })) })) };
  switch (delta.kind) {
    case 'scan': {
      const through = noticeSequence(delta.through);
      if (delta.eligible.length > NOTICE_BATCH_LIMIT) throw new Error('Notice discovery batch too large');
      const eligible = delta.eligible.map(postIdentity).sort((a, b) => a.seq - b.seq);
      if (eligible.length === NOTICE_BATCH_LIMIT && through !== eligible[eligible.length - 1].seq) throw new Error('Capped notice scan cannot over-advance its frontier');
      const seqs = new Set<number>(); const ids = new Set<string>();
      for (const post of eligible) {
        if (post.seq > through || seqs.has(post.seq) || ids.has(post.postId)) throw new Error('Conflicting notice scan');
        seqs.add(post.seq); ids.add(post.postId);
        const prior = state.pending.find((p) => p.seq === post.seq || p.postId === post.postId);
        if (prior && (prior.seq !== post.seq || prior.postId !== post.postId)) throw new Error('Conflicting notice post identity');
      }
      if (through <= state.scannedThrough) return current;
      let next = state.scannedThrough + 1;
      for (const post of eligible.filter((p) => p.seq > state.scannedThrough)) {
        if (next < post.seq) {
          state.terminal = coverNoticeInterval(state.terminal, next, post.seq - 1);
          state.excludedSequenceCount += post.seq - next;
        }
        state.pending.push(post);
        next = post.seq + 1;
      }
      if (next <= through) {
        state.terminal = coverNoticeInterval(state.terminal, next, through);
        state.excludedSequenceCount += through - next + 1;
      }
      state.scannedThrough = through;
      return state;
    }
    case 'intent': {
      boundedId(delta.attemptId);
      boundedId(delta.handoffProcess);
      if (!Number.isFinite(delta.startedAt) || delta.startedAt < 0 || !delta.posts.length || delta.posts.length > NOTICE_BATCH_LIMIT) throw new Error('Invalid notice attempt');
      const posts = delta.posts.map(postIdentity).sort((a, b) => a.seq - b.seq);
      if (new Set(posts.map((p) => p.seq)).size !== posts.length) throw new Error('Duplicate attempt coverage');
      const digest = noticeCoverageDigest(posts);
      const existing = state.attempts.find((a) => a.attemptId === delta.attemptId);
      if (existing) {
        if (existing.coverageDigest !== digest) throw new Error('Notice attempt key conflict');
        return current;
      }
      for (const post of posts) {
        const pending = state.pending.find((p) => p.seq === post.seq && p.postId === post.postId);
        if (!pending || pending.attemptId || noticeCovered(state.terminal, post.seq)) throw new Error('Notice coverage is not ready');
        pending.attemptId = delta.attemptId;
      }
      state.attempts.push({ attemptId: delta.attemptId, coverageDigest: digest, posts, startedAt: delta.startedAt, handoffProcess: delta.handoffProcess, status: 'intent' });
      return state;
    }
    case 'queued': {
      if (delta.messageId !== undefined) boundedId(delta.messageId);
      const attempt = state.attempts.find((a) => a.attemptId === delta.attemptId);
      if (!attempt || attempt.status === 'uncertain') return current;
      if (attempt.messageId && delta.messageId && attempt.messageId !== delta.messageId) throw new Error('Notice runtime message conflict');
      if (attempt.status === 'queued' && attempt.messageId === delta.messageId) return current;
      attempt.status = 'queued';
      if (delta.messageId !== undefined) attempt.messageId = delta.messageId;
      return state;
    }
    case 'settle': {
      if (!['accepted', 'uncertain', 'unsubmitted'].includes(delta.outcome)) throw new Error('Unsupported notice settlement');
      const attempt = state.attempts.find((a) => a.attemptId === delta.attemptId);
      if (!attempt) return current; // stale callback cannot recreate retired/accepted coverage
      if (delta.outcome === 'uncertain') {
        if (attempt.status === 'uncertain') return current;
        attempt.status = 'uncertain'; attempt.reason = 'handoff_unknown';
        return state;
      }
      if (delta.outcome === 'unsubmitted' && attempt.status === 'uncertain') throw new Error('Uncertainty cannot become proven unsubmitted');
      if (delta.outcome === 'accepted') {
        const proof = delta.acknowledgement;
        if (attempt.reason === 'recovered') throw new Error('Recovered notice cannot accept a live acknowledgement');
        if (!proof || proof.kind !== 'same-process-exact-handoff' || proof.handoffProcess !== attempt.handoffProcess || proof.coverageDigest !== attempt.coverageDigest) throw new Error('Notice acceptance requires exact live handoff provenance');
        if (attempt.status === 'uncertain') state.lateAcknowledgementCount++;
      }
      state.attempts = state.attempts.filter((a) => a !== attempt);
      if (delta.outcome === 'accepted') {
        const seqs = new Set(attempt.posts.map((p) => p.seq));
        state.pending = state.pending.filter((p) => !seqs.has(p.seq));
        for (const seq of seqs) state.terminal = coverNoticeInterval(state.terminal, seq);
        state.acceptedCount += seqs.size;
      } else {
        for (const post of state.pending) if (post.attemptId === attempt.attemptId) delete post.attemptId;
      }
      return state;
    }
    case 'recover': {
      let changed = false;
      for (const attempt of state.attempts) if (attempt.status !== 'uncertain') {
        attempt.status = 'uncertain'; attempt.reason = 'recovered'; changed = true;
      }
      return changed ? state : current;
    }
    default: {
      const unknown: never = delta;
      throw new Error(`Unsupported notice delta: ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

export function noticeLegacyFloor(state: SequencedNoticeState): number {
  return contiguousNoticeFloor(state.terminal, state.baselineThrough);
}

/** Checkpoint input is untrusted storage, not permission to silently repair a gap. */
export function validateNoticeState(value: unknown): SequencedNoticeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notice checkpoint');
  const state = value as SequencedNoticeState;
  if (state.schemaVersion !== 1 || state.minWriterVersion !== 1 || !state.recipient || typeof state.recipient !== 'object') throw new Error('Unsupported notice checkpoint');
  recipientIdentity(state.recipient);
  noticeSequence(state.baselineThrough); noticeSequence(state.scannedThrough);
  if (state.baselineThrough > state.scannedThrough || !Array.isArray(state.pending) || !Array.isArray(state.attempts)) throw new Error('Invalid notice checkpoint frontier');
  const terminal = validateNoticeIntervals(state.terminal);
  if (terminal.some(([lo, hi]) => lo <= state.baselineThrough || hi > state.scannedThrough)) throw new Error('Notice checkpoint coverage outside scan');
  const seqs = new Set<number>(); const ids = new Set<string>();
  let all = [...terminal];
  for (const post of state.pending) {
    postIdentity(post);
    if (post.seq <= state.baselineThrough || post.seq > state.scannedThrough || seqs.has(post.seq) || ids.has(post.postId) || noticeCovered(terminal, post.seq)) throw new Error('Invalid sparse notice checkpoint');
    if (post.attemptId !== undefined) boundedId(post.attemptId);
    seqs.add(post.seq); ids.add(post.postId); all = coverNoticeInterval(all, post.seq);
  }
  if (contiguousNoticeFloor(all, state.baselineThrough) !== state.scannedThrough) throw new Error('Notice checkpoint has an unrecorded gap');
  const attempts = new Set<string>();
  for (const attempt of state.attempts) {
    boundedId(attempt.attemptId); boundedId(attempt.handoffProcess);
    if (attempts.has(attempt.attemptId) || !['intent', 'queued', 'uncertain'].includes(attempt.status) || !Array.isArray(attempt.posts)
      || !attempt.posts.length || attempt.posts.length > NOTICE_BATCH_LIMIT || !Number.isFinite(attempt.startedAt) || attempt.startedAt < 0) throw new Error('Invalid checkpoint attempt');
    attempts.add(attempt.attemptId);
    if (attempt.messageId !== undefined) boundedId(attempt.messageId);
    const covered = new Set<number>();
    for (const post of attempt.posts) {
      postIdentity(post);
      if (covered.has(post.seq) || !state.pending.some((p) => p.seq === post.seq && p.postId === post.postId && p.attemptId === attempt.attemptId)) throw new Error('Checkpoint attempt coverage mismatch');
      covered.add(post.seq);
    }
    if (noticeCoverageDigest(attempt.posts) !== attempt.coverageDigest) throw new Error('Checkpoint attempt digest mismatch');
    if (state.pending.filter((p) => p.attemptId === attempt.attemptId).length !== covered.size) throw new Error('Checkpoint attempt coverage incomplete');
  }
  if (state.pending.some((p) => p.attemptId !== undefined && !attempts.has(p.attemptId))) throw new Error('Checkpoint attempt is missing');
  noticeSequence(state.acceptedCount); noticeSequence(state.excludedSequenceCount); noticeSequence(state.lateAcknowledgementCount);
  const terminalCount = terminal.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);
  if (state.acceptedCount + state.excludedSequenceCount !== terminalCount) throw new Error('Checkpoint terminal count mismatch');
  return { ...state, recipient: { ...state.recipient }, terminal, pending: state.pending.map((p) => ({ ...p })), attempts: state.attempts.map((a) => ({ ...a, posts: a.posts.map((p) => ({ ...p })) })) };
}
