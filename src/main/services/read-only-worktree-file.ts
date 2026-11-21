import { constants, type BigIntStats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

export type WorktreeFile = { state: 'ok'; bytes: Buffer; mode: '100644' | '100755'; truncated?: boolean } | { state: 'missing' | 'unsafe' | 'too-large' | 'directory' | 'unreadable' };

/** One selected file beneath a trusted root. Pin ancestors and the no-follow descriptor before/after reading.
 * Prefix mode is explicit; its consumer must verify framing before calling any section complete. */
export async function readOnlyWorktreeFile(root: string, relative: string, maxBytes = 1024 * 1024, options: { prefix?: boolean } = {}): Promise<WorktreeFile> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((s) => !s || s === '.' || s === '..' || s === '.git')) return { state: 'unsafe' };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const anchor = await fs.realpath(root);
    const expected = new Map<string, BigIntStats>([[anchor, await fs.lstat(anchor, { bigint: true })]]);
    let file = anchor;
    for (const segment of relative.split('/')) {
      file = path.join(file, segment);
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink()) return { state: 'unsafe' };
      expected.set(file, stat);
    }
    const leaf = expected.get(file)!;
    if (!leaf.isFile()) return { state: leaf.isDirectory() ? 'directory' : 'unsafe' };
    if (!options.prefix && leaf.size > BigInt(maxBytes)) return { state: 'too-large' };
    const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
    const verify = async () => {
      for (const [member, prior] of expected) {
        const current = await fs.lstat(member, { bigint: true });
        const resolved = await fs.realpath(member);
        const rel = path.relative(anchor, resolved);
        if (current.isSymbolicLink() || !same(prior, current) || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('changed');
      }
    };
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !same(leaf, opened)) return { state: 'unsafe' };
    await verify();
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, Number(opened.size) + 1));
    let size = 0;
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    await verify();
    const after = await handle.stat({ bigint: true });
    if (after.mtimeNs !== opened.mtimeNs || after.size !== opened.size || after.ctimeNs !== opened.ctimeNs) return { state: 'unreadable' };
    return size > maxBytes && !options.prefix ? { state: 'too-large' } : { state: 'ok', bytes: bytes.subarray(0, options.prefix ? Math.min(size, maxBytes) : size), mode: (opened.mode & BigInt(0o111)) !== BigInt(0) ? '100755' : '100644',
      ...(options.prefix && { truncated: size > maxBytes || opened.size > BigInt(maxBytes) }) };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' && !handle ? 'missing' : 'unreadable' };
  } finally { await handle?.close(); }
}
