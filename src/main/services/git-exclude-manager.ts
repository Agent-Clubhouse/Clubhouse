import * as fsp from 'fs/promises';
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

export async function addExclusions(projectPath: string, tag: string, patterns: string[]): Promise<void> {
  const excludePath = await getExcludePath(projectPath);
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
  await fsp.writeFile(excludePath, existing + separator + linesToAdd.join('\n') + '\n', 'utf-8');
}

export async function removeExclusions(projectPath: string, tag: string): Promise<void> {
  const excludePath = await getExcludePath(projectPath);
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

  await fsp.writeFile(excludePath, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''), 'utf-8');
}
