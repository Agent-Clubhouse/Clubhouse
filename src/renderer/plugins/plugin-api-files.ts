import type { PluginContext, PluginManifest, FilesAPI, Disposable } from '../../shared/plugin-types';
import { hasPermission } from './plugin-api-shared';
import { rendererLog } from './renderer-logger';
import { usePluginStore } from './plugin-store';

/** Global counter for unique file watch subscription IDs. */
let _watchIdCounter = 0;

export function resolvePath(projectPath: string, relativePath: string): string {
  // Normalize: join project path with relative path, then check for traversal
  const resolved = relativePath.startsWith('/')
    ? relativePath
    : `${projectPath}/${relativePath}`;

  // Simple traversal check: resolved must start with projectPath
  // Normalize double slashes and resolve .. manually
  const normalizedProject = projectPath.replace(/\/+$/, '');
  const normalizedResolved = resolved.replace(/\/+/g, '/');

  // Check for path traversal via ..
  if (normalizedResolved.includes('/../') || normalizedResolved.endsWith('/..') || normalizedResolved === '..') {
    throw new Error('Path traversal is not allowed');
  }

  if (!normalizedResolved.startsWith(normalizedProject + '/') && normalizedResolved !== normalizedProject) {
    throw new Error('Path traversal is not allowed');
  }

  return normalizedResolved;
}

/**
 * Compute the stable, absolute data directory for a plugin.
 * App-scoped: ~/.clubhouse/plugin-data/{pluginId}/files
 * Project-scoped: ~/.clubhouse/plugin-data/{pluginId}/files/{projectId}
 */
export function computeDataDir(pluginId: string, projectId?: string): string {
  const home = typeof process !== 'undefined'
    ? (process.env.HOME || process.env.USERPROFILE)
    : undefined;
  const root = home || '/tmp';
  const base = `${root}/.clubhouse/plugin-data/${pluginId}/files`;
  return projectId ? `${base}/${projectId}` : base;
}

/**
 * Compute the workspace root for a plugin.
 * All plugins: ~/.clubhouse/plugin-data/{pluginId}/workspace
 */
export function computeWorkspaceRoot(pluginId: string): string {
  const home = typeof process !== 'undefined'
    ? (process.env.HOME || process.env.USERPROFILE)
    : undefined;
  const root = home || '/tmp';
  return `${root}/.clubhouse/plugin-data/${pluginId}/workspace`;
}

/** Creates a FilesAPI scoped to an arbitrary base path (for external roots). forRoot() throws (no nesting). */
export function createFilesAPIForRoot(basePath: string): FilesAPI {
  return {
    get dataDir(): string {
      throw new Error('dataDir is not available on external root FilesAPI');
    },
    async readTree(relativePath = '.', options?: { includeHidden?: boolean; depth?: number }) {
      const fullPath = resolvePath(basePath, relativePath);
      return window.clubhouse.file.readTree(fullPath, options);
    },
    async readFile(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      return window.clubhouse.file.read(fullPath);
    },
    async readBinary(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      return window.clubhouse.file.readBinary(fullPath);
    },
    async writeFile(relativePath: string, content: string) {
      const fullPath = resolvePath(basePath, relativePath);
      await window.clubhouse.file.write(fullPath, content);
    },
    async stat(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      return window.clubhouse.file.stat(fullPath);
    },
    async rename(oldRelativePath: string, newRelativePath: string) {
      const oldFull = resolvePath(basePath, oldRelativePath);
      const newFull = resolvePath(basePath, newRelativePath);
      await window.clubhouse.file.rename(oldFull, newFull);
    },
    async copy(srcRelativePath: string, destRelativePath: string) {
      const srcFull = resolvePath(basePath, srcRelativePath);
      const destFull = resolvePath(basePath, destRelativePath);
      await window.clubhouse.file.copy(srcFull, destFull);
    },
    async mkdir(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      await window.clubhouse.file.mkdir(fullPath);
    },
    async delete(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      await window.clubhouse.file.delete(fullPath);
    },
    async showInFolder(relativePath: string) {
      const fullPath = resolvePath(basePath, relativePath);
      await window.clubhouse.file.showInFolder(fullPath);
    },
    async search(query: string, options?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
      includeGlobs?: string[];
      excludeGlobs?: string[];
      maxResults?: number;
      contextLines?: number;
    }) {
      return window.clubhouse.file.search(basePath, query, options);
    },
    forRoot(): FilesAPI {
      throw new Error('forRoot() cannot be called on an external root FilesAPI (no nesting)');
    },
    watch(): Disposable {
      throw new Error('watch() is not available on external root FilesAPI');
    },
  };
}

export function createFilesAPI(ctx: PluginContext, manifest?: PluginManifest): FilesAPI {
  const { projectPath } = ctx;
  if (!projectPath) {
    throw new Error('FilesAPI requires projectPath');
  }

  return {
    dataDir: computeDataDir(ctx.pluginId, ctx.projectId),
    async readTree(relativePath = '.', options?: { includeHidden?: boolean; depth?: number }) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.readTree(fullPath, options);
    },
    async readFile(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.read(fullPath);
    },
    async readBinary(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.readBinary(fullPath);
    },
    async writeFile(relativePath: string, content: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.write(fullPath, content);
    },
    async stat(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.stat(fullPath);
    },
    async rename(oldRelativePath: string, newRelativePath: string) {
      const oldFull = resolvePath(projectPath, oldRelativePath);
      const newFull = resolvePath(projectPath, newRelativePath);
      await window.clubhouse.file.rename(oldFull, newFull);
    },
    async copy(srcRelativePath: string, destRelativePath: string) {
      const srcFull = resolvePath(projectPath, srcRelativePath);
      const destFull = resolvePath(projectPath, destRelativePath);
      await window.clubhouse.file.copy(srcFull, destFull);
    },
    async mkdir(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.mkdir(fullPath);
    },
    async delete(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.delete(fullPath);
    },
    async showInFolder(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.showInFolder(fullPath);
    },
    forRoot(rootName: string): FilesAPI {
      if (!hasPermission(manifest, 'files.external')) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'files.external' permission to use api.files.forRoot()`);
      }
      if (!manifest?.externalRoots) {
        throw new Error(`Plugin '${ctx.pluginId}' has no externalRoots declared`);
      }
      const rootEntry = manifest.externalRoots.find((r) => r.root === rootName);
      if (!rootEntry) {
        throw new Error(`Unknown external root "${rootName}" — not declared in plugin manifest`);
      }
      // Read the base path from plugin settings via the declared settingKey
      const settingsKey = (ctx.scope === 'project' || ctx.scope === 'dual') && ctx.projectId
        ? `${ctx.projectId}:${ctx.pluginId}`
        : `app:${ctx.pluginId}`;
      const allSettings = usePluginStore.getState().pluginSettings[settingsKey] || {};
      let basePath = allSettings[rootEntry.settingKey] as string | undefined;
      if (!basePath || typeof basePath !== 'string') {
        throw new Error(`External root "${rootName}" setting "${rootEntry.settingKey}" is not configured`);
      }
      // Expand tilde to home directory
      if (basePath.startsWith('~/') || basePath === '~') {
        const home = typeof process !== 'undefined' ? process.env.HOME : undefined;
        if (home) {
          basePath = basePath === '~' ? home : `${home}${basePath.slice(1)}`;
        }
      }
      // Resolve relative paths against project root
      if (!basePath.startsWith('/') && ctx.projectPath) {
        basePath = `${ctx.projectPath}/${basePath}`;
      }
      return createFilesAPIForRoot(basePath);
    },
    async search(query: string, options?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
      includeGlobs?: string[];
      excludeGlobs?: string[];
      maxResults?: number;
      contextLines?: number;
    }) {
      return window.clubhouse.file.search(projectPath, query, options);
    },
    watch(glob: string, callback: (events: import('../../shared/plugin-types').FileEvent[]) => void): Disposable {
      if (!hasPermission(manifest, 'files.watch')) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'files.watch' permission to use api.files.watch()`);
      }
      const watchId = `plugin:${ctx.pluginId}:${++_watchIdCounter}`;
      const fullGlob = projectPath ? `${projectPath}/${glob}` : glob;

      // Start the watch on the main process
      window.clubhouse.file.watchStart(watchId, fullGlob).catch((err: Error) => {
        rendererLog(ctx.pluginId, 'error', `Failed to start file watch: ${err.message}`);
      });

      // Listen for events
      const handler = (_event: unknown, data: { watchId: string; events: import('../../shared/plugin-types').FileEvent[] }) => {
        if (data.watchId === watchId) {
          callback(data.events);
        }
      };
      window.clubhouse.file.onWatchEvent(handler);

      return {
        dispose() {
          window.clubhouse.file.offWatchEvent(handler);
          window.clubhouse.file.watchStop(watchId).catch(() => {});
        },
      };
    },
  };
}
