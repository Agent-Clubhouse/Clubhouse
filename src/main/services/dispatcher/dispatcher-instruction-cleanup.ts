/**
 * Cleaning up instruction files an older Dispatcher wrote (#3805 follow-up).
 *
 * Until v0.43.0-beta.7 the Dispatcher's instructions ended with a copy of
 * `memory/index.md` under `## Your memory index`. The active CLI's file is
 * written whole at every start, so it loses that copy at once. A CLI the
 * Dispatcher no longer runs on is never written again, so its file kept the
 * copy (up to 8 KB) for good. This takes the copy out of those files, and
 * nothing else.
 *
 * What goes is the section from the heading to the end of the file: the old
 * writer put it last. The file is kept as it was, once, in
 * `.clubhouse/instruction-backups/`, so text a person added after the copy
 * isn't lost either.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { appLog } from '../log-service';

const NS = 'core:dispatcher';

/** The heading and first line the old writer put before the copied index. Nothing else matches. */
const LEGACY_INDEX_SECTION = /(?:^|\r?\n)## Your memory index\r?\n\r?\nThis is `memory\/index\.md` as it was when this file was written\.\r?\n/;

/**
 * `text` without the memory index copy an older Dispatcher appended, or null
 * when it has none. The text before it stays exactly as it was, apart from the
 * blank lines that separated it from the copy.
 */
export function withoutLegacyMemoryIndex(text: string): string | null {
  const match = LEGACY_INDEX_SECTION.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index).replace(/\s+$/, '');
  return before ? `${before}${text.includes('\r\n') ? '\r\n' : '\n'}` : '';
}

/** Keep `content` under a name no earlier backup has. */
async function keepBackup(dir: string, providerId: string, content: string): Promise<void> {
  const folder = path.join(dir, '.clubhouse', 'instruction-backups');
  await fsp.mkdir(folder, { recursive: true });
  const stamp = Date.now();
  for (let n = 0; n < 100; n++) {
    const name = `${providerId}-instructions-${stamp}${n === 0 ? '' : `-${n}`}.md`;
    try {
      await fsp.writeFile(path.join(folder, name), content, { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('No free backup name');
}

/**
 * Take the old memory index copy out of the instruction files of every CLI but
 * `active`, in the Dispatcher folder `dir`. The active CLI's file is written
 * whole by the caller. One file that can't be read or written is logged and
 * left as it is; the rest are still cleaned.
 */
export async function removeLegacyMemoryIndexCopies(
  dir: string,
  active: Pick<OrchestratorProvider, 'id'>,
  providers: readonly OrchestratorProvider[],
): Promise<void> {
  for (const provider of providers) {
    if (provider.id === active.id) continue;
    try {
      // A symlink or special file is refused by the bounded read, and so left alone.
      const text = await (provider.inspectInstructions ?? provider.readInstructions).call(provider, dir);
      const cleaned = withoutLegacyMemoryIndex(text);
      if (cleaned === null) continue;
      await keepBackup(dir, provider.id, text);
      await provider.writeInstructions(dir, cleaned);
      appLog(NS, 'info', 'Removed an old memory index copy from an inactive CLI\'s Dispatcher instructions', {
        meta: { provider: provider.id, bytesBefore: Buffer.byteLength(text, 'utf8'), bytesAfter: Buffer.byteLength(cleaned, 'utf8') },
      });
    } catch (err) {
      // telemetry-exempt: logged; the file stays as it was and the next start tries again
      appLog(NS, 'warn', 'Could not clean an inactive CLI\'s Dispatcher instructions', {
        meta: { provider: provider.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
