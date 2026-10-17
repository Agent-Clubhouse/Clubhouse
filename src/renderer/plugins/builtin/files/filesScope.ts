import { useMemo } from 'react';
import type { FileSearchResult } from '../../../../shared/types';
import type { FilesAPI, GitAPI, PluginAPI, PluginContext } from '../../../../shared/plugin-types';
import { relativeTo, useChromeScope } from '../../../chrome/scope';
import { createFilesAPI } from '../../plugin-api-files';
import { createGitAPI } from '../../plugin-api-project';
import { manifest } from './manifest';

/**
 * Files in the new chrome follows the sidebar selection (spec §4.5): the tree,
 * search and git badges all read the scope's resolved cwd, and open tabs are
 * kept per scope.
 */
export interface FilesScope {
  /** `api` pointed at the scope's cwd. The same object when there is no scope or it is the project root. */
  api: PluginAPI;
  /** Tree root relative to `api.context.projectPath`, or null without a scope (classic layout, remote projects). */
  root: string | null;
  /** Which set of open tabs is current: an agent's worktree, or null for the project root. */
  key: string | null;
}

function prefixed(prefix: string, path: string): string {
  return `${prefix}/${path}`;
}

function unprefixed(prefix: string, path: string): string {
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

/**
 * `api` with its files and git calls pointed at `cwd`.
 *
 * - A worktree inside the project keeps project-relative paths (the tree root
 *   is the worktree's folder), so only search and git need to run in `cwd`,
 *   with their paths mapped back.
 * - A worktree outside the project cannot be reached through project-relative
 *   paths, so the whole API is rebased on `cwd` and the tree root is '.'.
 */
export function scopeFilesApi(api: PluginAPI, cwd: string): PluginAPI {
  const projectPath = api.context.projectPath || '';
  if (!cwd || !projectPath || cwd === projectPath) return api;

  const ctx: PluginContext = {
    pluginId: manifest.id,
    pluginPath: '',
    scope: 'project',
    projectId: api.context.projectId,
    projectPath: cwd,
    subscriptions: [],
    settings: {},
  };
  const cwdGit = createGitAPI(ctx);
  const inside = relativeTo(projectPath, cwd);

  let files: FilesAPI;
  let git: GitAPI;
  let context = api.context;
  if (inside === '.') {
    files = createFilesAPI(ctx, manifest);
    git = cwdGit;
    context = { ...api.context, projectPath: cwd };
  } else {
    const base = api.files;
    files = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'search') {
          return async (query: string, options?: Parameters<FilesAPI['search']>[1]): Promise<FileSearchResult> => {
            const result = await window.clubhouse.file.search(cwd, query, options);
            return { ...result, results: result.results.map((r: FileSearchResult['results'][number]) => ({ ...r, filePath: prefixed(inside, r.filePath) })) };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    git = {
      async status() {
        return (await cwdGit.status()).map((s) => ({ ...s, path: prefixed(inside, s.path) }));
      },
      log: (limit) => cwdGit.log(limit),
      currentBranch: () => cwdGit.currentBranch(),
      diff: (filePath, staged) => cwdGit.diff(unprefixed(inside, filePath), staged),
    };
  }

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === 'files') return files;
      if (prop === 'git') return git;
      if (prop === 'context') return context;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function useFilesScope(api: PluginAPI): FilesScope {
  const scope = useChromeScope(api.context.projectId);
  const cwd = scope?.cwd ?? null;
  const key = scope?.isWorktree && scope.agentId ? `agent:${scope.agentId}` : null;
  const scopedApi = useMemo(() => (cwd ? scopeFilesApi(api, cwd) : api), [api, cwd]);
  const root = cwd === null ? null : relativeTo(scopedApi.context.projectPath || '', cwd);
  return { api: scopedApi, root, key };
}
