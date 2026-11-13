import { HANDOFF_LIMITS } from '../../shared/handoffs';
import { parseHandoffCancellation, type HandoffCancellation, type HandoffCommandStorage } from './handoff-coordinator';
import { createSettingsStore, type SettingsStore } from './settings-store';

interface Notice { key: string; version: number; state: 'claimed' | 'delivered' }
interface CommandFile { v: 1; commands: HandoffCancellation[]; notices: Notice[] }

function parseFile(raw: unknown): CommandFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff commands.');
  const value = raw as CommandFile;
  if (value.v !== 1 || Object.keys(value).some((key) => !['v', 'commands', 'notices'].includes(key))
    || !Array.isArray(value.commands) || value.commands.length > HANDOFF_LIMITS.records
    || !Array.isArray(value.notices) || value.notices.length > HANDOFF_LIMITS.records * 2) throw new Error('Invalid handoff commands.');
  const commands = value.commands.map(parseHandoffCancellation);
  if (new Set(commands.map((command) => command.id)).size !== commands.length) throw new Error('Invalid handoff commands.');
  for (const notice of value.notices) {
    if (!notice || typeof notice !== 'object' || Object.keys(notice).some((key) => !['key', 'version', 'state'].includes(key))
      || typeof notice.key !== 'string' || !notice.key || notice.key.length > 256 || notice.key.includes('\0')
      || !Number.isInteger(notice.version) || notice.version < 1 || notice.version > HANDOFF_LIMITS.history
      || !['claimed', 'delivered'].includes(notice.state)) throw new Error('Invalid handoff commands.');
  }
  if (new Set(value.notices.map((notice) => notice.key)).size !== value.notices.length) throw new Error('Invalid handoff commands.');
  return structuredClone({ v: 1, commands, notices: value.notices });
}

/** Cancellation and notice claims are durable before any network/runtime side effect. */
export class HandoffCommandStore implements HandoffCommandStorage {
  private readonly disk: SettingsStore<CommandFile>;
  private committed: CommandFile | undefined;
  private loadFailed = false;
  private lock: Promise<unknown> = Promise.resolve();
  constructor() {
    this.disk = createSettingsStore('handoff-commands.json', { v: 1, commands: [], notices: [] }, parseFile, {
      atomic: true, mode: 0o600, rollBackFailedSaves: true,
      onLoad: (result) => {
        if ('error' in result) this.loadFailed = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
        else {
          try { parseFile(JSON.parse(result.raw)); }
          catch {
            // telemetry-exempt: fail closed below; never log raw commands
            this.loadFailed = true;
          }
        }
      },
    });
  }
  private snapshot(): CommandFile {
    if (!this.committed) {
      const raw = this.disk.get();
      if (this.loadFailed) throw new Error('Handoff commands are unreadable; they have not been overwritten.');
      this.committed = parseFile(raw);
    }
    return this.committed;
  }
  private change(update: (file: CommandFile) => void): Promise<void> {
    const work = async () => {
      const next = structuredClone(this.snapshot());
      update(next);
      const checked = parseFile(next);
      await this.disk.save(checked);
      this.committed = checked;
    };
    const result = this.lock.then(work, work);
    this.lock = result;
    return result;
  }
  list(): HandoffCancellation[] { return structuredClone(this.snapshot().commands); }
  put(raw: HandoffCancellation): Promise<void> {
    const command = parseHandoffCancellation(raw);
    return this.change((file) => {
      const existing = file.commands.find((item) => item.id === command.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(command)) throw new Error('Conflicting handoff cancellation.');
      if (!existing) file.commands.push(command);
    });
  }
  remove(operationId: string): Promise<void> {
    return this.change((file) => { file.commands = file.commands.filter((command) => command.operationId !== operationId); });
  }
  async claimNotice(key: string, version: number): Promise<boolean> {
    let claimed = false;
    await this.change((file) => {
      const notice = file.notices.find((item) => item.key === key);
      if (notice && notice.version >= version) return;
      file.notices = file.notices.filter((item) => item.key !== key);
      file.notices.push({ key, version, state: 'claimed' });
      claimed = true;
    });
    return claimed;
  }
  deliveredNotice(key: string, version: number): Promise<void> {
    return this.change((file) => {
      const notice = file.notices.find((item) => item.key === key && item.version === version);
      if (notice) notice.state = 'delivered';
    });
  }
  hasNotice(key: string, version: number): boolean {
    return this.snapshot().notices.some((notice) => notice.key === key && notice.version >= version);
  }
}
