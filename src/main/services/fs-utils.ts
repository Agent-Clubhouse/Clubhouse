import { access, constants } from 'fs/promises';

/**
 * Async equivalent of fs.existsSync.
 * Returns true if the path exists, false otherwise.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
