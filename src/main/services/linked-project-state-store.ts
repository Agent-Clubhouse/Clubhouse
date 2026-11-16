/**
 * The durable replica of linked project state (shared/linked-project-state.ts):
 * Pin and Mark inactive records for linked copies, shared by Annex Network
 * computers. Serialized like the project link replica, so disk writes and
 * incoming merges can't overtake each other.
 */
import {
  LINKED_PROJECT_STATE_MAX_RECORDS, LINKED_PROJECT_STATE_PAGE_SIZE, indexLinkedState, linkedStateRecordKey,
  mergeLinkedStateRecords, parseIncomingLinkedStateRecords, parseLinkedStateRecords,
  type LinkedProjectStateRecord, type LinkedStateIndex,
} from '../../shared/linked-project-state';
import { createSettingsStore } from './settings-store';
import { appLog } from './log-service';
import type { ReplicaChange, ReplicaStore } from './replica-network';

interface Saved { version: 1; records: LinkedProjectStateRecord[] }
interface StoreOptions {
  read(): Saved;
  save(value: Saved, current?: () => boolean): Promise<void>;
  now?(): number;
}

export class LinkedProjectStateStore implements ReplicaStore<LinkedProjectStateRecord> {
  private state: Saved | undefined;
  private indexed: { records: LinkedProjectStateRecord[]; index: LinkedStateIndex } | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(change: ReplicaChange) => void>();
  constructor(private options: StoreOptions) {}
  private get(): Saved { return this.state ??= this.options.read(); }
  records(): LinkedProjectStateRecord[] { return structuredClone(this.get().records); }
  /** The current records, read-only and uncopied. */
  current(): readonly LinkedProjectStateRecord[] { return this.get().records; }
  /** The current records by reference and field; the same object until they change. */
  index(): LinkedStateIndex {
    const records = this.get().records;
    if (this.indexed?.records !== records) this.indexed = { records, index: indexLinkedState(records) };
    return this.indexed.index;
  }
  page(after?: string): { records: LinkedProjectStateRecord[]; next?: string } {
    const rows = this.get().records;
    let low = 0, high = rows.length;
    if (after !== undefined) while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (linkedStateRecordKey(rows[middle]) <= after) low = middle + 1;
      else high = middle;
    }
    const records = structuredClone(rows.slice(low, low + LINKED_PROJECT_STATE_PAGE_SIZE));
    return { records, ...(low + records.length < rows.length && { next: linkedStateRecordKey(records[records.length - 1]) }) };
  }
  onChange(listener: (change: ReplicaChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Nothing to import: values from before sharing come in as clock-zero records. */
  migrate(): Promise<void> { return Promise.resolve(); }
  private update(change: (records: LinkedProjectStateRecord[]) => LinkedProjectStateRecord[], source?: string, current: () => boolean = () => true): Promise<void> {
    const work = async () => {
      if (!current()) throw new Error('Linked project state pairing changed.');
      const previous = this.get(), records = change(previous.records);
      if (records === previous.records) return;
      const next: Saved = { version: 1, records };
      await this.options.save(next, current);
      this.state = next;
      for (const listener of this.listeners) {
        try { listener({ source, recordsChanged: true }); }
        catch (error) { // telemetry-exempt: committed records survive a failed observer
          appLog('core:annex', 'warn', 'Linked project state observer failed', { meta: { error: error instanceof Error ? error.message : String(error) } });
        }
      }
    };
    const result = this.pending.then(work, work);
    this.pending = result;
    return result;
  }
  /** This computer's own writes: explicit edits and clock-zero values from before sharing. */
  write(records: readonly LinkedProjectStateRecord[]): Promise<void> {
    if (!records.length) return Promise.resolve();
    const valid = parseLinkedStateRecords(records);
    return this.update((current) => mergeLinkedStateRecords(current, valid));
  }
  /** Records from another computer. */
  merge(raw: unknown, source: string, current?: () => boolean): Promise<void> {
    const incoming = parseIncomingLinkedStateRecords(raw, LINKED_PROJECT_STATE_MAX_RECORDS, (this.options.now ?? Date.now)());
    return this.update((records) => mergeLinkedStateRecords(records, incoming), source, current);
  }
  /** Resolves once every queued change has been saved. */
  settled(): Promise<void> { return this.pending.then((): void => undefined, (): void => undefined); }
}

function parseSaved(raw: Record<string, unknown>): Saved {
  if (raw.version !== 1) throw new Error('Invalid linked project state.');
  return { version: 1, records: mergeLinkedStateRecords([], parseLinkedStateRecords(raw.records)) };
}
let store: LinkedProjectStateStore | undefined;
export function linkedProjectStateStore(): LinkedProjectStateStore {
  if (store) return store;
  let unreadable = false;
  const disk = createSettingsStore<Saved>('network-linked-project-state.json', { version: 1, records: [] }, parseSaved, {
    atomic: true, mode: 0o600, rollBackFailedSaves: true,
    onLoad: (result) => {
      if ('error' in result) unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      else { try { parseSaved(JSON.parse(result.raw)); } catch { unreadable = true; /* telemetry-exempt: never overwrite an unreadable shared record */ } }
    },
  });
  store = new LinkedProjectStateStore({
    read: () => { const value = disk.get(); if (unreadable) throw new Error('Linked project state could not be read.'); return value; },
    save: (value, current) => disk.save(value, { prepare: async () => {}, check: () => { if (current && !current()) throw new Error('Linked project state pairing changed.'); } }),
  });
  return store;
}
export function _resetLinkedProjectStateStoreForTesting(): void { store = undefined; }
