import { isDeepStrictEqual } from 'util';
import { HANDOFF_LIMITS, parseHandoff, type Handoff } from '../../shared/handoffs';
import { scanHandoffSecrets } from '../../shared/handoff-secrets';
import { createSettingsStore, type SettingsStore } from './settings-store';

interface HandoffFile {
  schemaVersion: 1;
  records: Handoff[];
}

export interface HandoffStorage {
  get(id: string): Handoff | undefined;
  list(): Handoff[];
  transact(id: string, change: (current: Handoff | undefined) => Promise<Handoff> | Handoff): Promise<Handoff>;
}

function safeRecord(raw: unknown): Handoff {
  const record = parseHandoff(raw);
  if (scanHandoffSecrets('handoff-record.json', new TextEncoder().encode(JSON.stringify(record))).length > 0) {
    throw new Error('Handoff metadata is blocked by secret rules.');
  }
  return record;
}

function parseFile(raw: unknown): HandoffFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !('schemaVersion' in raw) || raw.schemaVersion !== 1 || !('records' in raw)
    || !Array.isArray(raw.records) || raw.records.length > HANDOFF_LIMITS.records
    || Object.keys(raw).some((key) => key !== 'schemaVersion' && key !== 'records')) throw new Error('Invalid handoff store.');
  const records = raw.records.map(safeRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('Invalid handoff store.');
  return { schemaVersion: 1, records };
}

/** Every newer copy must retain the entire offer and the common history prefix. */
export function assertHandoffExtension(current: Handoff, next: Handoff): void {
  const offer = (record: Handoff) => ({
    schemaVersion: record.schemaVersion, id: record.id, createdAt: record.createdAt,
    from: record.from, to: record.to, task: record.task, mode: record.mode, manifest: record.manifest,
  });
  if (!isDeepStrictEqual(offer(current), offer(next)) || next.version < current.version
    || !isDeepStrictEqual(current.history, next.history.slice(0, current.history.length))) {
    throw new Error('Conflicting handoff history.');
  }
}

/**
 * Reads expose only the last committed snapshot, never the settings store's
 * optimistic cache. A failed disk write cannot acknowledge an agreement.
 */
export class HandoffStore implements HandoffStorage {
  private readonly disk: SettingsStore<HandoffFile>;
  private committed: HandoffFile | undefined;
  private loadFailed = false;
  private lock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.disk = createSettingsStore<HandoffFile>(
      'handoffs.json', { schemaVersion: 1, records: [] }, parseFile,
      {
        atomic: true, mode: 0o600, rollBackFailedSaves: true,
        onLoad: (result) => {
          if ('error' in result) {
            this.loadFailed = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
          } else {
            try {
              parseFile(JSON.parse(result.raw));
            } catch {
              // telemetry-exempt: access fails explicitly below; never log task text or raw JSON
              this.loadFailed = true;
            }
          }
        },
      },
    );
  }

  private snapshot(): HandoffFile {
    if (!this.committed) {
      const loaded = this.disk.get();
      if (this.loadFailed) throw new Error('Handoff store is unreadable; it has not been overwritten.');
      this.committed = parseFile(loaded);
    }
    return this.committed;
  }

  get(id: string): Handoff | undefined {
    const record = this.snapshot().records.find((item) => item.id === id);
    return record && structuredClone(record);
  }

  list(): Handoff[] {
    return structuredClone(this.snapshot().records);
  }

  transact(id: string, change: (current: Handoff | undefined) => Promise<Handoff> | Handoff): Promise<Handoff> {
    const work = async () => {
      const file = this.snapshot();
      const current = file.records.find((item) => item.id === id);
      const next = safeRecord(await change(current && structuredClone(current)));
      if (next.id !== id) throw new Error('Conflicting handoff id.');
      if (current) assertHandoffExtension(current, next);
      else if (file.records.length >= HANDOFF_LIMITS.records) throw new Error('Handoff store is full.');
      if (current && isDeepStrictEqual(current, next)) return structuredClone(current);
      const updated: HandoffFile = {
        schemaVersion: 1, records: [...file.records.filter((item) => item.id !== id), next],
      };
      await this.disk.save(updated);
      this.committed = updated;
      return structuredClone(next);
    };
    const result = this.lock.then(work, work);
    this.lock = result;
    return result;
  }
}
