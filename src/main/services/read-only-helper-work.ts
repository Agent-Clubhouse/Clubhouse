/** The work line in a selected agent's direct helper list, with no disposal effects. */
import * as fs from 'fs';
import type { HelperDisposeChecks } from '../../shared/types';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget, type AgentConfigTarget } from './agent-config-reader';
import { captureReadOnlyAgentTargetWitness } from './read-only-agent-target-witness';
import { readOnlyGit, readOnlyRepositoryRoot, ReadOnlyGitError } from './read-only-repository-changes';
import { readOnlyWorktreeFile } from './read-only-worktree-file';
import { CLUBHOUSE_WRITTEN_FILES, onlyClubhouseChangesFromTexts } from './clubhouse-owned-files';
import type { HelperEntry } from './helper-index';

const unknown = (): HelperDisposeChecks => ({ dirty: 0, unpushed: 0, unmerged: null, error: 'Couldn’t read helper work.' });
const sameFolder = (a: string, b: string) => fs.realpathSync(a) === fs.realpathSync(b);

/** No recovering inventories, caller refs, Git helpers/fetches or file contents in the result. */
export async function readOnlyHelperWork(parent: AgentConfigTarget, entry: HelperEntry, authorized: () => boolean): Promise<HelperDisposeChecks> {
  try {
    const check = () => { if (!authorized()) throw new Error('revoked'); };
    const checked = async <T>(promise: Promise<T>) => { const value = await promise; check(); return value; };
    check();
    const helper = await checked(resolveAgentConfigTarget(entry.config.id, undefined, { strict: true }));
    if (helper.agent.id !== entry.config.id || JSON.stringify(helper.agent) !== JSON.stringify(entry.config)
      || isDisposedAgent(helper.agent) || helper.agent.creation || helper.agent.parentAgentId !== parent.agent.id
      || !sameFolder(helper.project.path, entry.projectPath)
      || !sameFolder(helper.agent.parentProjectPath || helper.project.path, parent.project.path)) return unknown();
    const parentWitness = captureReadOnlyAgentTargetWitness(parent);
    const helperWitness = captureReadOnlyAgentTargetWitness(helper);
    const worktree = helper.agent.worktreePath;
    let hasWorktree = false;
    if (worktree) {
      try { hasWorktree = fs.statSync(worktree).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const cwd = hasWorktree ? worktree! : helper.project.path;
    const root = await checked(readOnlyRepositoryRoot(cwd));
    if (!root) {
      if (hasWorktree) return unknown();
      check();
      return parentWitness.current() && helperWitness.current() ? { dirty: 0, unpushed: 0, unmerged: 0 } : unknown();
    }
    const rootStat = fs.statSync(root, { bigint: true });
    const git = (args: string[], max?: number) => checked(readOnlyGit(root, args, max)).then((bytes) => bytes.toString());
    const refs = new Set<string>(), own = new Set<string>();
    let admittedBranch: string | null = null;
    const commit = async (ref: string) => {
      try {
        const oid = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid commit.');
        return oid;
      } catch (error) { if (error instanceof ReadOnlyGitError && error.code === 1) return null; throw error; }
    };
    if (helper.agent.branch) {
      const ref = `refs/heads/${helper.agent.branch}`;
      await git(['check-ref-format', ref]);
      const oid = await commit(ref);
      admittedBranch = oid;
      if (oid) { refs.add(oid); own.add(helper.agent.branch); }
    }
    let admittedHead: string | null = null;
    if (hasWorktree) {
      admittedHead = await commit('HEAD');
      if (admittedHead) refs.add(admittedHead);
      try {
        const head = (await git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
        if (head.startsWith('refs/heads/')) own.add(head.slice('refs/heads/'.length));
      } catch (error) { if (!(error instanceof ReadOnlyGitError) || error.code !== 1) throw error; }
    }
    let dirty = 0;
    if (hasWorktree) {
      const parts = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).split('\0');
      const changes: Array<{ status: string; path: string }> = [];
      for (let i = 0; i < parts.length && parts[i]; i++) {
        const line = parts[i];
        if (!/^.{2} .+$/s.test(line)) throw new Error('Invalid status.');
        const status = line.slice(0, 2).trim(), file = line.slice(3);
        if (/[RC]/.test(status)) { if (!parts[++i]) throw new Error('Incomplete rename.'); }
        // Expand only folders which may be solely generated bridge/hook files.
        if (status === '??' && file.endsWith('/') && CLUBHOUSE_WRITTEN_FILES.some((known) => known.startsWith(file))) {
          const expanded = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file])).split('\0').filter(Boolean);
          for (const item of expanded) changes.push({ status: item.slice(0, 2).trim(), path: item.slice(3) });
        } else changes.push({ status, path: file });
      }
      for (const change of changes) {
        let owned = false;
        if (CLUBHOUSE_WRITTEN_FILES.includes(change.path) && (change.status === '??' || /^[MA]{1,2}$/.test(change.status))) {
          const current = await checked(readOnlyWorktreeFile(root, change.path, 256 * 1024));
          if (current.state !== 'ok') throw new Error('Cannot classify generated config.');
          let base: string | null = null;
          if (admittedHead) {
            const item = (await git(['ls-tree', '-z', admittedHead, '--', change.path])).split('\0').filter(Boolean);
            if (item.length) {
              const blob = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(item[0]);
              if (item.length !== 1 || !blob) throw new Error('Unsafe committed config.');
              base = await git(['cat-file', 'blob', blob[2]], 256 * 1024);
            }
          }
          owned = onlyClubhouseChangesFromTexts(change.path, current.bytes.toString('utf8'), base);
        }
        if (!owned) dirty++;
      }
    }
    let unpushed = 0;
    if (refs.size) {
      const remote = (await git(['remote'])).trim();
      if (remote && !(await git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'])).trim()) throw new Error('Remote not fetched.');
      const range = remote ? ['--remotes'] : [...own].map((name) => `--exclude=${name}`).concat('--branches');
      const count = (await git(['rev-list', '--count', ...refs, '--not', ...range])).trim();
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error('Invalid count.');
      unpushed = Number(count);
    }
    if (await checked(readOnlyRepositoryRoot(cwd)) !== root || hasWorktree && await commit('HEAD') !== admittedHead) return unknown();
    if (helper.agent.branch && await commit(`refs/heads/${helper.agent.branch}`) !== admittedBranch) return unknown();
    check();
    // Synchronous final fence after all Git/file awaits, including stopped helpers.
    const finalRoot = fs.statSync(root, { bigint: true });
    if (fs.realpathSync(cwd) !== root || rootStat.dev !== finalRoot.dev || rootStat.ino !== finalRoot.ino
      || !parentWitness.current() || !helperWitness.current()) return unknown();
    return { dirty, unpushed, unmerged: null };
  } catch { /* telemetry-exempt: no raw errors, names, refs or contents leave a work summary. */ return unknown(); }
}
