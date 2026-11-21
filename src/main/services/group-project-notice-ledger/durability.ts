import { open, type FileHandle } from 'fs/promises';

export type NoticeDirectoryDurability = 'not-observed' | 'directory-synced' | 'file-sync-only';
type DirectoryHandle = Pick<FileHandle, 'sync' | 'close'>;

/** Narrow platform limitation only; actual IO/disk-full errors always propagate. */
export function noticeDirectorySyncUnsupported(platform: NodeJS.Platform, error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return platform === 'win32' && typeof code === 'string' && ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(code);
}

export class NoticeDirectoryFlusher {
  private observed: NoticeDirectoryDurability = 'not-observed';
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly openDirectory: (directory: string) => Promise<DirectoryHandle> = (directory) => open(directory, 'r'),
  ) {}
  get observation(): NoticeDirectoryDurability { return this.observed; }
  async flush(directory: string): Promise<void> {
    let handle: DirectoryHandle | undefined;
    try {
      handle = await this.openDirectory(directory);
      await handle.sync();
      if (this.observed === 'not-observed') this.observed = 'directory-synced';
    } catch (error) {
      if (!noticeDirectorySyncUnsupported(this.platform, error)) throw error; // telemetry-exempt: owning store reports IO failure and refuses handoff
      // File writes were separately synced. Do not claim directory/power-loss proof.
      this.observed = 'file-sync-only';
    } finally { await handle?.close(); }
  }
}
