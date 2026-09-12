import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import * as path from 'path';

/**
 * Manages entries in .git/info/exclude (shared across all worktrees instantly,
 * no commit required, untracked).
 */

async function getExcludePath(projectPath: string): Promise<string> {
  // Resolve the real .git dir (handles worktrees where .git is a file)
  const gitPath = path.join(projectPath, '.git');
  try {
    const stat = await fsp.stat(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/real/.git/worktrees/..."
      const content = (await fsp.readFile(gitPath, 'utf-8')).trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        // Navigate up from worktrees/<name> to the real .git dir
        const worktreeGitDir = match[1];
        const realGitDir = path.resolve(projectPath, worktreeGitDir, '..', '..');
        return path.join(realGitDir, 'info', 'exclude');
      }
    }
  } catch {
    // Fall through to default
  }
  return path.join(projectPath, '.git', 'info', 'exclude');
}

function tagFor(tag: string): string {
  return `# ${tag}`;
}

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(excludePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(excludePath) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  writeQueues.set(excludePath, current);
  return current.finally(() => {
    if (writeQueues.get(excludePath) === current) {
      writeQueues.delete(excludePath);
    }
  });
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(tempPath, content, 'utf-8');

  try {
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    const canRetryAfterRemovingDestination = code === 'EEXIST'
      || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
    if (!canRetryAfterRemovingDestination) {
      await fsp.rm(tempPath, { force: true });
      throw error;
    }

    try {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    } catch (retryError) {
      await fsp.rm(tempPath, { force: true });
      throw retryError;
    }
  }
}

export async function addExclusions(projectPath: string, tag: string, patterns: string[]): Promise<void> {
  const excludePath = await getExcludePath(projectPath);
  return enqueueWrite(excludePath, async () => {
    const marker = tagFor(tag);
    const newLines = patterns.map((p) => `${p} ${marker}`);

    // Ensure the info/ directory exists
    const dir = path.dirname(excludePath);
    await fsp.mkdir(dir, { recursive: true });

    let existing = '';
    try {
      existing = await fsp.readFile(excludePath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    const linesToAdd = newLines.filter((line) => !existing.includes(line));
    if (linesToAdd.length === 0) return;

    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writeAtomically(excludePath, existing + separator + linesToAdd.join('\n') + '\n');
  });
}

export async function removeExclusions(projectPath: string, tag: string): Promise<void> {
  const excludePath = await getExcludePath(projectPath);
  return enqueueWrite(excludePath, async () => {
    const marker = tagFor(tag);

    let existing: string;
    try {
      existing = await fsp.readFile(excludePath, 'utf-8');
    } catch {
      return; // No exclude file
    }

    const lines = existing.split('\n');
    const filtered = lines.filter((line) => !line.includes(marker));

    // Remove trailing blank lines
    while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
      filtered.pop();
    }

    await writeAtomically(excludePath, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''));
  });
}
