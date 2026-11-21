/** Existing array codec. Byte compatibility is not a bounded-memory claim. */
import { applyNoticeDelta, noticeRecipientKey, validateNoticeState, type NoticeDelta, type NoticeRecipient, type SequencedNoticeState } from './state';
import { NOTICE_PAGE_BYTES, NoticeLedgerStorageError, NoticeLedgerValidationError, type NoticePhysicalCodec, type NoticePhysicalPages } from './framed-journal';

type CheckpointPage = { kind: 'index'; children: string[] }
  | { kind: 'metadata'; value: Omit<SequencedNoticeState, 'terminal' | 'pending' | 'attempts'> }
  | { kind: 'terminal'; items: SequencedNoticeState['terminal'] }
  | { kind: 'pending'; items: SequencedNoticeState['pending'] }
  | { kind: 'attempts'; items: SequencedNoticeState['attempts'] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function readPages(pages: NoticePhysicalPages, root: string, visiting = new Set<string>(), retained?: Set<string>): Promise<CheckpointPage[]> {
  if (!isHash(root) || visiting.has(root) || visiting.size > 32) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice page reference/depth');
  visiting.add(root); retained?.add(root);
  const page = await pages.read(root);
  if (!object(page)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice page');
  let result: CheckpointPage[];
  if (page.kind === 'metadata' && object(page.value)) result = [page as unknown as CheckpointPage];
  else if (['terminal', 'pending', 'attempts'].includes(page.kind as string) && Array.isArray(page.items)) result = [page as unknown as CheckpointPage];
  else if (page.kind === 'index' && Array.isArray(page.children) && page.children.length > 0 && page.children.every(isHash)) {
    result = [];
    for (const child of page.children) result.push(...await readPages(pages, child, visiting, retained));
  } else throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Unsupported notice checkpoint page');
  visiting.delete(root); return result;
}

export function legacyNoticeCodec(recipientInput: NoticeRecipient): NoticePhysicalCodec<SequencedNoticeState, NoticeDelta, NoticeDelta> {
  const recipient = structuredClone(recipientInput);
  const recipientKey = noticeRecipientKey(recipient);
  const validate = (state: SequencedNoticeState) => {
    if (noticeRecipientKey(state.recipient) !== recipientKey || state.recipient.groupId !== recipient.groupId
      || state.recipient.host !== recipient.host || state.recipient.agentId !== recipient.agentId || state.recipient.generation !== recipient.generation) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice recipient does not match storage');
  };
  return {
    minWriterVersion: 1,
    validate,
    prepare: async (current, delta) => {
      try {
        const state = applyNoticeDelta(current, delta); validate(state);
        return state === current ? undefined : { state, record: delta };
      } catch (error) {
        // This block calls only the pure reducer and exact-key validator: no IO.
        throw new NoticeLedgerValidationError(error instanceof Error ? error.message : 'Invalid notice delta', error);
      }
    },
    replay: async (current, value) => {
      if (!object(value)) throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Invalid notice delta');
      return applyNoticeDelta(current, value as unknown as NoticeDelta);
    },
    restore: async (root, pages) => {
      const decoded = await readPages(pages, root);
      const metadata = decoded.filter((p) => p.kind === 'metadata');
      if (metadata.length !== 1 || metadata[0].kind !== 'metadata') throw new NoticeLedgerStorageError('notice_ledger_corrupt', 'Notice checkpoint metadata missing or repeated');
      const state = { ...metadata[0].value, terminal: [] as SequencedNoticeState['terminal'], pending: [] as SequencedNoticeState['pending'], attempts: [] as SequencedNoticeState['attempts'] };
      for (const p of decoded) {
        if (p.kind === 'terminal') state.terminal.push(...p.items);
        else if (p.kind === 'pending') state.pending.push(...p.items);
        else if (p.kind === 'attempts') state.attempts.push(...p.items);
      }
      return validateNoticeState(state);
    },
    checkpoint: async (state, pages) => {
      const { terminal, pending, attempts, ...metadata } = state;
      const children = [await pages.put({ kind: 'metadata', value: metadata })];
      const append = async (kind: 'terminal' | 'pending' | 'attempts', items: unknown[]) => {
        let batch: unknown[] = [];
        for (const item of items) {
          const candidate = [...batch, item];
          if (Buffer.byteLength(JSON.stringify({ kind, items: candidate })) > NOTICE_PAGE_BYTES || kind === 'attempts' && candidate.length > 256) {
            if (!batch.length) throw new Error('Notice checkpoint item exceeds its page bound');
            children.push(await pages.put({ kind, items: batch })); batch = [item];
          } else batch = candidate;
        }
        if (batch.length) children.push(await pages.put({ kind, items: batch }));
      };
      await append('terminal', terminal); await append('pending', pending); await append('attempts', attempts);
      let level = children;
      while (level.length > 1000) {
        const parents: string[] = [];
        for (let offset = 0; offset < level.length; offset += 1000) parents.push(await pages.put({ kind: 'index', children: level.slice(offset, offset + 1000) }));
        level = parents;
      }
      return pages.put({ kind: 'index', children: level });
    },
    collect: async (root, pages) => {
      const retained = new Set<string>(); await readPages(pages, root, new Set(), retained);
      await pages.retireLegacyPages(retained);
    },
  };
}
