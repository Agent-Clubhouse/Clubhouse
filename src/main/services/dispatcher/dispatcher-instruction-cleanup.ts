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
 * isn't lost either. The file is replaced only if it is still the plain file
 * that was read, through a temporary file and a rename.
 */
import { createHash } from 'crypto';
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

/**
 * Keep `content`, named by what it holds, so the same text is kept once however
 * many starts find it (a write that keeps failing doesn't add a backup each time).
 * An earlier backup is never overwritten.
 */
async function keepBackup(dir: string, providerId: string, content: string): Promise<void> {
  const folder = path.join(dir, '.clubhouse', 'instruction-backups');
  await fsp.mkdir(folder, { recursive: true });
  const hash = createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
  for (let n = 0; n < 100; n++) {
    const file = path.join(folder, `${providerId}-instructions-${hash}${n === 0 ? '' : `-${n}`}.md`);
    try {
      await fsp.writeFile(file, content, { encoding: 'utf-8', flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Already kept (the usual case), unless the name is held by something else.
      if (await fsp.readFile(file, 'utf-8').then((kept) => kept === content, () => false)) return;
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
      if (!provider.replaceInstructionsIfUnchanged) throw new Error('This CLI cannot replace its instructions file safely.');
      if (!await provider.replaceInstructionsIfUnchanged(dir, text, cleaned)) {
        appLog(NS, 'info', 'An inactive CLI\'s Dispatcher instructions changed or are not a plain file; left as they are', { meta: { provider: provider.id } });
        continue;
      }
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
