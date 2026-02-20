import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages entries in .git/info/exclude (shared across all worktrees instantly,
 * no commit required, untracked).
 */

function getExcludePath(projectPath: string): string {
  // Resolve the real .git dir (handles worktrees where .git is a file)
  const gitPath = path.join(projectPath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: /path/to/real/.git/worktrees/..."
      const content = fs.readFileSync(gitPath, 'utf-8').trim();
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

export function addExclusions(projectPath: string, tag: string, patterns: string[]): void {
  const excludePath = getExcludePath(projectPath);
  const marker = tagFor(tag);
  const newLines = patterns.map((p) => `${p} ${marker}`);

  // Ensure the info/ directory exists
  const dir = path.dirname(excludePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing = '';
  try {
    existing = fs.readFileSync(excludePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const linesToAdd = newLines.filter((line) => !existing.includes(line));
  if (linesToAdd.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(excludePath, existing + separator + linesToAdd.join('\n') + '\n', 'utf-8');
}

export function removeExclusions(projectPath: string, tag: string): void {
  const excludePath = getExcludePath(projectPath);
  const marker = tagFor(tag);

  let existing: string;
  try {
    existing = fs.readFileSync(excludePath, 'utf-8');
  } catch {
    return; // No exclude file
  }

  const lines = existing.split('\n');
  const filtered = lines.filter((line) => !line.includes(marker));

  // Remove trailing blank lines
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
    filtered.pop();
  }

  fs.writeFileSync(excludePath, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''), 'utf-8');
}
