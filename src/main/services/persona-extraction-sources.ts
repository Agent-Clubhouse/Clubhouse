/** Bounded file capture, not the provider's effective runtime instruction graph. */
import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';

const LIMIT = 2 * 1024 * 1024;

/** Inspect a named root document only; never expand references or recurse into rules. */
export async function readExtractionDocument(root: string, name: string): Promise<string | null> {
  const filePath = path.join(root, name);
  let observed = false;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await fs.lstat(filePath);
    observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > LIMIT) throw new Error('unreadable');
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > LIMIT) throw new Error('changed');
    const bytes = Buffer.alloc(LIMIT + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count > LIMIT || after.size !== count || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('changed');
    return bytes.subarray(0, count).toString('utf8');
  } catch (error) {
    if (!observed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Fixed message: filesystem errors can contain private paths or instruction text.
    throw new Error(`Cannot extract ${name}. Check that it is a readable regular file and try again.`);
  } finally { await handle?.close(); }
}
