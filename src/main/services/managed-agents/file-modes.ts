/**
 * Skill import (#2894, D92): whether each dropped or picked file is
 * executable, read from the file itself rather than guessed from its name.
 * Only the mode is read, never the content, and nothing is run.
 */
import { promises as fsp } from 'fs';

/**
 * One answer per path, in order: true or false from the file's mode, or null
 * when it can't be told: Windows (no executable bit), no path (the file
 * didn't come from disk), or anything that isn't a regular file.
 */
export async function executableBits(paths: readonly string[], platform: NodeJS.Platform = process.platform): Promise<Array<boolean | null>> {
  if (platform === 'win32') return paths.map((): null => null);
  return Promise.all(paths.map(async (p): Promise<boolean | null> => {
    if (!p) return null;
    try {
      const st = await fsp.lstat(p);
      return st.isFile() ? (st.mode & 0o111) !== 0 : null;
    } catch {
      // telemetry-exempt: a file that went away is guessed from its name in the dialog
      return null;
    }
  }));
}
