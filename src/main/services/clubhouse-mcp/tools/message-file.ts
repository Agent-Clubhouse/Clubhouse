import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Caller-controlled task ids and filename hints are metadata, never storage paths. */
export async function createMessageFile(content: string, tempRoot: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tempRoot, 'clubhouse-a2a-'));
  const file = path.join(directory, `${randomUUID()}.md`);
  try {
    // Exclusive creation rejects existing files and symlinks atomically on every platform.
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return file;
  } catch (error) {
    // Remove only an empty directory; never follow or overwrite an unexpected entry.
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function removeMessageFile(file: string): Promise<void> {
  await fs.unlink(file).catch(() => {});
  await fs.rmdir(path.dirname(file)).catch(() => {});
}
