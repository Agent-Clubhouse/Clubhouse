/** Fixed-recipient private root profile. No catalog, adoption or receipt authority. */
import * as path from 'path';
import { createHash } from 'crypto';
import { NoticePageIndex, type NoticeRootBarrier } from './pages';
import { decodePreparedNoticeHeader, type PreparedNoticeRoots } from './sparse-reader';
import { PreparedNoticeState, type SparseNoticeDelta } from './sparse-state';
import { noticeSequence } from './intervals';
import { noticeRecipientKey, type NoticeRecipient } from './state';
import { NoticeLedgerStorageError, NoticeLedgerValidationError, type NoticePhysicalCodec } from './framed-journal';

export interface NoticeRootState {
  readonly header: PreparedNoticeRoots;
  /** Populated only after final committed-root verification, or internal preparation. */
  readonly prepared?: PreparedNoticeState;
}
export interface NoticeRootInput {
  expectedHeaderDigest: string | null;
  delta: SparseNoticeDelta | { kind: 'initialize'; recipient: NoticeRecipient; baseline: number };
}
export interface NoticeRootRecord {
  kind: 'root';
  previousHeaderDigest: string | null;
  header: PreparedNoticeRoots;
}
const rootsOf = (header: PreparedNoticeRoots) => ['terminal', 'pending', 'ready', 'attempts', 'active', 'postIds'].map((name) => header.roots[name as keyof PreparedNoticeRoots['roots']]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
/** Metadata digest, not an authenticated file-set or runtime capability. */
export function noticeHeaderDigest(header: PreparedNoticeRoots): string {
  return createHash('sha256').update(JSON.stringify(canonical(header))).digest('hex');
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
function equalRecipient(a: NoticeRecipient, b: NoticeRecipient): boolean {
  return a.groupId === b.groupId && a.host === b.host && a.agentId === b.agentId && a.generation === b.generation;
}
/** All calls here precede index IO; errors can therefore be typed no-effect refusals. */
function inputNumbers(input: NoticeRootInput): void {
  try {
    if (!object(input) || !exact(input as unknown as Record<string, unknown>, ['expectedHeaderDigest', 'delta'])
      || input.expectedHeaderDigest !== null && (typeof input.expectedHeaderDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHeaderDigest))
      || !object(input.delta)) throw new Error('Invalid root transaction input');
    const delta = input.delta;
    if (delta.kind === 'initialize') { noticeSequence(delta.baseline); noticeRecipientKey(delta.recipient); }
    if (delta.kind === 'scan') { noticeSequence(delta.through); for (const p of delta.eligible) noticeSequence(p.seq); }
    if (delta.kind === 'intent') for (const p of delta.posts) noticeSequence(p.seq);
  } catch (error) { throw new NoticeLedgerValidationError(error instanceof Error ? error.message : 'Invalid root input', error); }
}

export function sparseRootCodec(directory: string, recipientInput: NoticeRecipient): NoticePhysicalCodec<NoticeRootState, NoticeRootInput, NoticeRootRecord> {
  const recipient = structuredClone(recipientInput); noticeRecipientKey(recipient);
  let index: NoticePageIndex | undefined;
  const getIndex = async () => index ??= await NoticePageIndex.open(path.join(directory, 'index'));
  const preparedBarriers = new WeakMap<NoticeRootState, NoticeRootBarrier>();
  const validate = (state: NoticeRootState) => {
    decodePreparedNoticeHeader(state.header);
    if (!equalRecipient(state.header.recipient, recipient)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Root full recipient does not match file-set owner');
  };
  const checkPrior = (current: NoticeRootState | undefined, expected: string | null) => {
    if ((current ? noticeHeaderDigest(current.header) : null) !== expected) throw new NoticeLedgerValidationError('Notice prior root changed');
  };
  const readRecord = (current: NoticeRootState | undefined, value: unknown): NoticeRootState => {
    if (!object(value) || !exact(value, ['kind', 'previousHeaderDigest', 'header']) || value.kind !== 'root') throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Unsupported root record fields');
    if ((current ? noticeHeaderDigest(current.header) : null) !== value.previousHeaderDigest) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Root prior header chain mismatch');
    const header = decodePreparedNoticeHeader(value.header); const state = { header }; validate(state);
    if (current && (header.baselineThrough !== current.header.baselineThrough || header.scannedThrough < current.header.scannedThrough
      || header.acceptedCount < current.header.acceptedCount || header.excludedSequenceCount < current.header.excludedSequenceCount
      || header.lateAcknowledgementCount < current.header.lateAcknowledgementCount)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Root record regresses committed generation');
    return state;
  };
  return {
    minWriterVersion: 2,
    profile: 'sequenced-sparse-v1',
    validate,
    prepare: async (current, input) => {
      inputNumbers(input); checkPrior(current, input.expectedHeaderDigest);
      const delta = input.delta;
      if (delta.kind === 'initialize' && (!exact(delta as unknown as Record<string, unknown>, ['kind', 'recipient', 'baseline']) || !equalRecipient(delta.recipient, recipient))) throw new NoticeLedgerValidationError('Root initialization recipient/fields mismatch');
      if (delta.kind === 'initialize' && current) throw new NoticeLedgerValidationError('Root generation already initialized');
      if (delta.kind !== 'initialize' && !current?.prepared) throw new NoticeLedgerValidationError('Root generation is not open and verified');
      const pages = await getIndex();
      const candidate = delta.kind === 'initialize' ? PreparedNoticeState.initialize(pages, recipient, delta.baseline) : await current!.prepared!.prepare(delta);
      if (candidate === current?.prepared) return undefined;
      const state: NoticeRootState = { header: candidate.preparedHeader, prepared: candidate }; validate(state);
      const barrier = await pages.prepareRootBarrier(rootsOf(state.header));
      preparedBarriers.set(state, barrier);
      return { state, record: { kind: 'root', previousHeaderDigest: input.expectedHeaderDigest, header: structuredClone(state.header) } };
    },
    assertPrepared: (state, record) => {
      const barrier = preparedBarriers.get(state);
      if (!index || !barrier || noticeHeaderDigest(record.header) !== noticeHeaderDigest(state.header)) throw new NoticeLedgerValidationError('No exact prepared root capability');
      index.assertRootBarrier(barrier, rootsOf(state.header));
    },
    replay: async (current, value) => readRecord(current, value),
    // Frames are bounded metadata; tree verification happens ONCE on the final
    // committed root before returning open, not once per historical log record.
    finalizeOpen: async (state) => {
      const prepared = await PreparedNoticeState.openPrepared(await getIndex(), state.header);
      return { header: prepared.preparedHeader, prepared };
    },
    checkpoint: async (state, pages) => {
      validate(state);
      // Root pages already earned barriers before their authoritative record.
      // This small checkpoint header earns independent flat-file sync/barriers.
      return pages.put({ kind: 'sparse-header', header: state.header });
    },
    restore: async (root, pages) => {
      const value = await pages.read(root);
      if (!object(value) || !exact(value, ['kind', 'header']) || value.kind !== 'sparse-header') throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid root checkpoint header');
      const state = { header: decodePreparedNoticeHeader(value.header) }; validate(state); return state;
    },
    // No root GC: obsolete versions accumulate until separate reachability proof.
  };
}
