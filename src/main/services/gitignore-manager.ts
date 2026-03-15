import * as fsp from 'fs/promises';
import * as path from 'path';

function getGitignorePath(projectPath: string): string {
  return path.join(projectPath, '.gitignore');
}

function tagFor(pluginId: string): string {
  return `# clubhouse-plugin: ${pluginId}`;
}

export async function addEntries(projectPath: string, pluginId: string, patterns: string[]): Promise<void> {
  const gitignorePath = getGitignorePath(projectPath);
  const tag = tagFor(pluginId);
  const newLines = patterns.map((p) => `${p} ${tag}`);

  let existing = '';
  try {
    existing = await fsp.readFile(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const linesToAdd = newLines.filter((line) => !existing.includes(line));
  if (linesToAdd.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fsp.writeFile(gitignorePath, existing + separator + linesToAdd.join('\n') + '\n', 'utf-8');
}

export async function removeEntries(projectPath: string, pluginId: string): Promise<void> {
  const gitignorePath = getGitignorePath(projectPath);
  const tag = tagFor(pluginId);

  let existing: string;
  try {
    existing = await fsp.readFile(gitignorePath, 'utf-8');
  } catch {
    return; // No .gitignore
  }

  const lines = existing.split('\n');
  const filtered = lines.filter((line) => !line.includes(tag));

  // Remove trailing blank lines that were left behind
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
    filtered.pop();
  }

  await fsp.writeFile(gitignorePath, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''), 'utf-8');
}

export async function isIgnored(projectPath: string, pattern: string): Promise<boolean> {
  const gitignorePath = getGitignorePath(projectPath);
  try {
    const content = await fsp.readFile(gitignorePath, 'utf-8');
    return content.split('\n').some((line) => line.trim().startsWith(pattern));
  } catch {
    return false;
  }
}
