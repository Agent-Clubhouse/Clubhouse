import type {
  PluginContext,
  PluginManifest,
  WorkspaceAPI,
  WorkspaceReadonlyAPI,
  WorkspaceProjectAPI,
  DirectoryEntry,
  Disposable,
} from '../../shared/plugin-types';
import type { FileNode } from '../../shared/types';
import { hasPermission, handlePermissionViolation } from './plugin-api-shared';
import { resolvePath, computeWorkspaceRoot } from './plugin-api-files';
import { rendererLog } from './renderer-logger';
import { usePluginStore } from './plugin-store';
import { useProjectStore } from '../stores/projectStore';

/** Global counter for unique workspace watch subscription IDs. */
let _workspaceWatchIdCounter = 0;

/**
 * Creates a file watch for workspace directories.
 * Shared by WorkspaceAPI, WorkspaceReadonlyAPI, and WorkspaceProjectAPI.
 */
function createWorkspaceWatch(
  ctx: PluginContext,
  basePath: string,
  glob: string,
  callback: (events: import('../../shared/plugin-types').FileEvent[]) => void,
): Disposable {
  const watchId = `workspace:${ctx.pluginId}:${++_workspaceWatchIdCounter}`;
  const fullGlob = `${basePath}/${glob}`;

  window.clubhouse.file.watchStart(watchId, fullGlob).catch((err: Error) => {
    rendererLog(ctx.pluginId, 'error', `Failed to start workspace watch: ${err.message}`);
  });

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
}

export function createWorkspaceAPI(ctx: PluginContext, manifest?: PluginManifest): WorkspaceAPI {
  const workspaceRoot = computeWorkspaceRoot(ctx.pluginId);

  return {
    get root(): string {
      return workspaceRoot;
    },

    async readFile(relativePath: string): Promise<string> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      return window.clubhouse.file.read(fullPath);
    },

    async writeFile(relativePath: string, content: string): Promise<void> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      await window.clubhouse.file.write(fullPath, content);
    },

    async mkdir(relativePath: string): Promise<void> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      await window.clubhouse.file.mkdir(fullPath);
    },

    async delete(relativePath: string): Promise<void> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      await window.clubhouse.file.delete(fullPath);
    },

    async stat(relativePath: string): Promise<import('../../shared/plugin-types').FileStatInfo> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      return window.clubhouse.file.stat(fullPath);
    },

    async exists(relativePath: string): Promise<boolean> {
      try {
        const fullPath = resolvePath(workspaceRoot, relativePath);
        await window.clubhouse.file.stat(fullPath);
        return true;
      } catch {
        return false;
      }
    },

    async listDir(relativePath = '.'): Promise<DirectoryEntry[]> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      return window.clubhouse.file.readTree(fullPath, { depth: 1 }).then(
        (nodes: FileNode[]) => nodes.map((n) => ({
          name: n.name,
          path: n.path,
          isDirectory: n.isDirectory,
        })),
      );
    },

    async readTree(relativePath = '.', opts?: { depth?: number }): Promise<FileNode[]> {
      const fullPath = resolvePath(workspaceRoot, relativePath);
      return window.clubhouse.file.readTree(fullPath, { depth: opts?.depth });
    },

    watch(glob: string, cb: (events: import('../../shared/plugin-types').FileEvent[]) => void): Disposable {
      if (!hasPermission(manifest, 'workspace.watch')) {
        throw new Error(`Plugin '${ctx.pluginId}' requires 'workspace.watch' permission to use api.workspace.watch()`);
      }
      return createWorkspaceWatch(ctx, workspaceRoot, glob, cb);
    },

    forPlugin(targetPluginId: string): WorkspaceReadonlyAPI {
      if (!hasPermission(manifest, 'workspace.cross-plugin')) {
        handlePermissionViolation(ctx.pluginId, 'workspace.cross-plugin', 'workspace.forPlugin()');
        throw new Error(`Plugin '${ctx.pluginId}' requires 'workspace.cross-plugin' permission to use api.workspace.forPlugin()`);
      }

      // Validate target plugin has workspace.shared permission (bilateral consent)
      const targetEntry = usePluginStore.getState().plugins[targetPluginId];
      if (!targetEntry) {
        throw new Error(`Target plugin not found: ${targetPluginId}`);
      }
      if (!hasPermission(targetEntry.manifest, 'workspace.shared')) {
        throw new Error(
          `Target plugin '${targetPluginId}' does not declare 'workspace.shared' permission. ` +
          'Cross-plugin workspace access requires bilateral consent.',
        );
      }

      const targetRoot = computeWorkspaceRoot(targetPluginId);
      return {
        get root(): string {
          return targetRoot;
        },
        async readFile(relativePath: string): Promise<string> {
          const fullPath = resolvePath(targetRoot, relativePath);
          return window.clubhouse.file.read(fullPath);
        },
        async stat(relativePath: string): Promise<import('../../shared/plugin-types').FileStatInfo> {
          const fullPath = resolvePath(targetRoot, relativePath);
          return window.clubhouse.file.stat(fullPath);
        },
        async exists(relativePath: string): Promise<boolean> {
          try {
            const fullPath = resolvePath(targetRoot, relativePath);
            await window.clubhouse.file.stat(fullPath);
            return true;
          } catch {
            return false;
          }
        },
        async listDir(relativePath = '.'): Promise<DirectoryEntry[]> {
          const fullPath = resolvePath(targetRoot, relativePath);
          return window.clubhouse.file.readTree(fullPath, { depth: 1 }).then(
            (nodes: FileNode[]) => nodes.map((n) => ({
              name: n.name,
              path: n.path,
              isDirectory: n.isDirectory,
            })),
          );
        },
        watch(glob: string, cb: (events: import('../../shared/plugin-types').FileEvent[]) => void): Disposable {
          if (!hasPermission(manifest, 'workspace.watch')) {
            throw new Error(`Plugin '${ctx.pluginId}' requires 'workspace.watch' permission to use workspace.forPlugin().watch()`);
          }
          return createWorkspaceWatch(ctx, targetRoot, glob, cb);
        },
      };
    },

    forProject(projectId: string): WorkspaceProjectAPI {
      if (!hasPermission(manifest, 'workspace.cross-project')) {
        handlePermissionViolation(ctx.pluginId, 'workspace.cross-project', 'workspace.forProject()');
        throw new Error(`Plugin '${ctx.pluginId}' requires 'workspace.cross-project' permission to use api.workspace.forProject()`);
      }

      // Validate target project exists
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      if (!project) {
        throw new Error(`Target project not found: ${projectId}`);
      }

      // Bilateral consent: target project must have this plugin enabled
      // App-scoped plugins are implicitly enabled in all projects
      const { projectEnabled, appEnabled } = usePluginStore.getState();
      if (!appEnabled.includes(ctx.pluginId)) {
        const enabledInTarget = projectEnabled[projectId] || [];
        if (!enabledInTarget.includes(ctx.pluginId)) {
          throw new Error(
            `Plugin '${ctx.pluginId}' is not enabled in target project '${project.name}'. ` +
            'Cross-project workspace access requires the plugin to be enabled in both projects.',
          );
        }
      }

      const projectRoot = `${project.path}/.clubhouse/plugin-data/${ctx.pluginId}`;
      return {
        get projectPath(): string {
          return project.path;
        },
        get projectId(): string {
          return projectId;
        },
        async readFile(relativePath: string): Promise<string> {
          const fullPath = resolvePath(projectRoot, relativePath);
          return window.clubhouse.file.read(fullPath);
        },
        async writeFile(relativePath: string, content: string): Promise<void> {
          const fullPath = resolvePath(projectRoot, relativePath);
          await window.clubhouse.file.write(fullPath, content);
        },
        async exists(relativePath: string): Promise<boolean> {
          try {
            const fullPath = resolvePath(projectRoot, relativePath);
            await window.clubhouse.file.stat(fullPath);
            return true;
          } catch {
            return false;
          }
        },
        async listDir(relativePath = '.'): Promise<DirectoryEntry[]> {
          const fullPath = resolvePath(projectRoot, relativePath);
          return window.clubhouse.file.readTree(fullPath, { depth: 1 }).then(
            (nodes: FileNode[]) => nodes.map((n) => ({
              name: n.name,
              path: n.path,
              isDirectory: n.isDirectory,
            })),
          );
        },
        watch(glob: string, cb: (events: import('../../shared/plugin-types').FileEvent[]) => void): Disposable {
          if (!hasPermission(manifest, 'workspace.watch')) {
            throw new Error(`Plugin '${ctx.pluginId}' requires 'workspace.watch' permission to use workspace.forProject().watch()`);
          }
          return createWorkspaceWatch(ctx, projectRoot, glob, cb);
        },
      };
    },
  };
}
