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

/**
 * Each tag's patterns sit between `# >>> <tag>` and `# <<< <tag>` lines. Git
 * has no trailing comments, so a pattern line must be the pattern alone.
 * Lines written before this format (`<pattern> # <tag>`) never matched
 * anything; they are removed whenever their tag is written.
 */
const blockStart = (tag: string) => `# >>> ${tag}`;
const blockEnd = (tag: string) => `# <<< ${tag}`;
const legacySuffix = (tag: string) => ` # ${tag}`;

/**
 * The file's lines without the tag's block and legacy lines, where the block
 * was, and the block's patterns. A block runs to its `# <<< tag` line. One
 * whose end line is gone (edited by hand) runs only to the next blank line,
 * the next comment or marker line, or the end of the file, so the person's
 * own lines after it are never taken as Clubhouse's.
 */
function splitTag(existing: string, tag: string): { lines: string[]; at: number; patterns: string[] } {
  const lines = existing.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const bare = lines.map((raw) => raw.replace(/\r$/, ''));
  const out: string[] = [];
  const patterns: string[] = [];
  const take = (line: string) => { if (line && !patterns.includes(line)) patterns.push(line); };
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (bare[i] === blockStart(tag)) {
      if (at < 0) at = out.length;
      let end = -1;
      for (let j = i + 1; j < lines.length && bare[j] !== blockStart(tag); j++) {
        if (bare[j] === blockEnd(tag)) { end = j; break; }
      }
      if (end >= 0) {
        for (let j = i + 1; j < end; j++) take(bare[j]);
        i = end;
      } else {
        let j = i + 1;
        for (; j < lines.length && bare[j] && !bare[j].startsWith('#'); j++) take(bare[j]);
        i = j - 1;
      }
      continue;
    }
    // An end line whose start was removed: Clubhouse's own marker, nothing else.
    if (bare[i] === blockEnd(tag)) continue;
    if (bare[i].endsWith(legacySuffix(tag))) { if (at < 0) at = out.length; continue; }
    out.push(lines[i]);
  }
  return { lines: out, at: at < 0 ? out.length : at, patterns };
}

/** The file with the tag's block holding exactly `patterns` (none: no block), or null when that's what it already says. */
function withTag(existing: string, tag: string, patterns: string[]): string | null {
  const { lines, at } = splitTag(existing, tag);
  const unique = [...new Set(patterns)];
  const block = unique.length > 0 ? [blockStart(tag), ...unique, blockEnd(tag)] : [];
  const next = [...lines.slice(0, at), ...block, ...lines.slice(at)];
  const content = next.length > 0 ? `${next.join('\n')}\n` : '';
  return content === existing ? null : content;
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

const RENAME_TRIES = 5;

/**
 * Write the file through a temporary file and a rename, so git never reads
 * half of it. The exclude file is never removed first. A rename refused for a
 * moment (Windows, another process has the file open) is tried again; one
 * still refused is replaced by copying the temporary file over it. If even
 * that fails, the temporary file is kept beside it with the whole content.
 */
async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(tempPath, content, 'utf-8');
  let lastError: unknown;
  for (let attempt = 1; attempt <= RENAME_TRIES; attempt++) {
    try {
      await fsp.rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
        await fsp.rm(tempPath, { force: true });
        throw error;
      }
      if (attempt < RENAME_TRIES) await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
  try {
    await fsp.copyFile(tempPath, filePath);
  } catch {
    // telemetry-exempt: rethrown below; the temporary file keeps the whole content
    throw lastError;
  }
  await fsp.rm(tempPath, { force: true });
}

async function rewrite(projectPath: string, tag: string, patternsFor: (current: string[]) => string[]): Promise<void> {
  const excludePath = await getExcludePath(projectPath);
  return enqueueWrite(excludePath, async () => {
    let existing = '';
    let found = true;
    try {
      existing = await fsp.readFile(excludePath, 'utf-8');
    } catch {
      found = false; // No exclude file yet
    }
    const content = withTag(existing, tag, patternsFor(splitTag(existing, tag).patterns));
    if (content === null || (!found && content === '')) return;
    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    await writeAtomically(excludePath, content);
  });
}

/** Add `patterns` to the tag's block, keeping what it already lists. */
export async function addExclusions(projectPath: string, tag: string, patterns: string[]): Promise<void> {
  return rewrite(projectPath, tag, (current) => [...current, ...patterns]);
}

/**
 * Make the tag's block exactly `patterns`: patterns it lists that aren't in
 * `patterns` come out, and the rest are added. Writes nothing when the file
 * already says that.
 */
export async function replaceExclusions(projectPath: string, tag: string, patterns: string[]): Promise<void> {
  return rewrite(projectPath, tag, () => patterns);
}

/** Remove the tag's block. */
export async function removeExclusions(projectPath: string, tag: string): Promise<void> {
  return rewrite(projectPath, tag, () => []);
}

/** Take `patterns` out of the tag's block, keeping the rest. Writes nothing when the block lists none of them. */
export async function removePatterns(projectPath: string, tag: string, patterns: string[]): Promise<void> {
  return rewrite(projectPath, tag, (current) => current.filter((p) => !patterns.includes(p)));
}

/** The patterns the tag's block lists, none when there is no block or no exclude file. */
export async function listExclusions(projectPath: string, tag: string): Promise<string[]> {
  try {
    return splitTag(await fsp.readFile(await getExcludePath(projectPath), 'utf-8'), tag).patterns;
  } catch {
    return []; // telemetry-exempt: no exclude file yet
  }
}
