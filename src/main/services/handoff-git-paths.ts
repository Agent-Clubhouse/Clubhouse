import * as path from 'path';

type Paths = Pick<typeof path, 'dirname' | 'relative' | 'isAbsolute'>;

/** Keep both Windows process startup and Git's explicit-directory setup within
 * their independent limits. Start from an existing ancestor of the bare repo. */
export function handoffGitLocation(bare: string, options: { windows?: boolean; paths?: Paths } = {}): { cwd: string; gitDir: string } | null {
  const paths = options.paths ?? path;
  const windows = options.windows ?? process.platform === 'win32';
  let cwd = paths.dirname(bare);
  for (;;) {
    const gitDir = paths.relative(cwd, bare) || '.';
    // Reserve a trailing separator and NUL in the Windows MAX_PATH buffer.
    if (!paths.isAbsolute(gitDir) && (!windows || cwd.length + 2 <= 260 && Buffer.byteLength(gitDir, 'utf8') < 220)) return { cwd, gitDir };
    const parent = paths.dirname(cwd);
    if (parent === cwd) return null;
    cwd = parent;
  }
}

/** Generated file arguments can be relative on the same volume. Bundle files
 * may remain absolute across drives: they are file I/O, never GIT_DIR. */
export function handoffGitFile(cwd: string, file: string, paths: Paths = path): string {
  const relative = paths.relative(cwd, file);
  return paths.isAbsolute(relative) ? file : relative || '.';
}
