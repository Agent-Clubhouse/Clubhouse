import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DurableAgentConfig, WorktreeStatus } from '../../shared/types';
import { withoutClubhouseOwnedChanges } from './clubhouse-owned-files';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** Hash actual edits, including further edits to an already-dirty or untracked file. No contents leave main. */
export async function deleteReviewFingerprint(config: DurableAgentConfig, work?: WorktreeStatus): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify({
    id: config.id, name: config.name, createdAt: config.createdAt, worktreePath: config.worktreePath,
    branch: config.branch, branchOwned: config.branchOwned, branchStartSha: config.branchStartSha,
    disposedAt: config.disposedAt, parentAgentId: config.parentAgentId,
    parentProjectPath: config.parentProjectPath, creation: config.creation, work,
  }));
  if (!config.worktreePath || !work?.isValid || work.worktreeMissing || work.checkError) return hash.digest('hex');
  const cwd = config.worktreePath;
  hash.update(await git(cwd, ['rev-parse', 'HEAD']));
  const entries = (await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0');
  const changed: { path: string; status: string; original?: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    changed.push({ path: entry.slice(3), status: status.trim(), ...(/[RC]/.test(status) && { original: entries[++i] }) });
  }
  for (const file of await withoutClubhouseOwnedChanges(cwd, changed)) {
    hash.update(JSON.stringify(file));
    hash.update(await git(cwd, ['diff', '--binary', 'HEAD', '--', file.path, ...(file.original ? [file.original] : [])]));
    hash.update(await git(cwd, ['diff', '--cached', '--binary', '--', file.path, ...(file.original ? [file.original] : [])]));
    const absolute = path.join(cwd, file.path);
    try {
      const stat = await fs.lstat(absolute);
      hash.update(String(stat.mode));
      hash.update(stat.isSymbolicLink() ? await fs.readlink(absolute) : stat.isFile() ? await fs.readFile(absolute) : String(stat.mtimeMs));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}
