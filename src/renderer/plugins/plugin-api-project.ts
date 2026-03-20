import type {
  PluginContext,
  ProjectAPI,
  ProjectsAPI,
  GitAPI,
  DirectoryEntry,
  GitStatus,
  GitCommit,
  ProjectInfo,
} from '../../shared/plugin-types';
import { useProjectStore } from '../stores/projectStore';
import { isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';

export function createProjectAPI(ctx: PluginContext): ProjectAPI {
  const { projectPath, projectId } = ctx;
  if (!projectPath || !projectId) {
    throw new Error('ProjectAPI requires projectPath and projectId');
  }

  return {
    projectPath,
    projectId,
    async readFile(relativePath: string): Promise<string> {
      const fullPath = `${projectPath}/${relativePath}`;
      return window.clubhouse.file.read(fullPath);
    },
    async writeFile(relativePath: string, content: string): Promise<void> {
      const fullPath = `${projectPath}/${relativePath}`;
      await window.clubhouse.file.write(fullPath, content);
    },
    async deleteFile(relativePath: string): Promise<void> {
      const fullPath = `${projectPath}/${relativePath}`;
      await window.clubhouse.file.delete(fullPath);
    },
    async fileExists(relativePath: string): Promise<boolean> {
      try {
        const fullPath = `${projectPath}/${relativePath}`;
        await window.clubhouse.file.read(fullPath);
        return true;
      } catch {
        return false;
      }
    },
    async listDirectory(relativePath = '.'): Promise<DirectoryEntry[]> {
      const fullPath = `${projectPath}/${relativePath}`;
      const tree = await window.clubhouse.file.readTree(fullPath);
      return tree.map((node: { name: string; path: string; isDirectory: boolean }) => ({
        name: node.name,
        path: node.path,
        isDirectory: node.isDirectory,
      }));
    },
  };
}

export function createProjectsAPI(): ProjectsAPI {
  return {
    list(): ProjectInfo[] {
      return useProjectStore.getState().projects.map((p) => ({
        id: p.id,
        name: p.displayName || p.name,
        path: p.path,
      }));
    },
    getActive(): ProjectInfo | null {
      const store = useProjectStore.getState();
      const project = store.projects.find((p) => p.id === store.activeProjectId);
      if (!project) return null;
      return { id: project.id, name: project.displayName || project.name, path: project.path };
    },
  };
}

export function createGitAPI(ctx: PluginContext): GitAPI {
  const { projectPath, projectId } = ctx;
  if (!projectPath) {
    throw new Error('GitAPI requires projectPath');
  }

  // Remote project: proxy git operations through annex client
  if (projectId && isRemoteProjectId(projectId)) {
    const parsed = parseNamespacedId(projectId);
    if (!parsed) throw new Error('Invalid remote project ID');
    const { satelliteId, agentId: origProjectId } = parsed;
    const gitOp = (operation: string, extra?: Record<string, unknown>) =>
      window.clubhouse.annexClient.gitOperation(satelliteId, origProjectId, { operation, ...extra });

    return {
      async status(): Promise<GitStatus[]> {
        const info = await gitOp('info') as any;
        return (info.status || []).map((s: { path: string; status: string; staged: boolean }) => ({
          path: s.path,
          status: s.status,
          staged: s.staged,
        }));
      },
      async log(limit = 20): Promise<GitCommit[]> {
        const info = await gitOp('info') as any;
        return (info.log || []).slice(0, limit).map((e: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
          hash: e.hash,
          shortHash: e.shortHash,
          subject: e.subject,
          author: e.author,
          date: e.date,
        }));
      },
      async currentBranch(): Promise<string> {
        const info = await gitOp('info') as any;
        return info.branch;
      },
      async diff(filePath: string, staged = false): Promise<string> {
        return gitOp('diff', { file: filePath, staged }) as Promise<string>;
      },
    };
  }

  return {
    async status(): Promise<GitStatus[]> {
      const info = await window.clubhouse.git.info(projectPath);
      return info.status.map((s: { path: string; status: string; staged: boolean }) => ({
        path: s.path,
        status: s.status,
        staged: s.staged,
      }));
    },
    async log(limit = 20): Promise<GitCommit[]> {
      const info = await window.clubhouse.git.info(projectPath);
      return info.log.slice(0, limit).map((e: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
        hash: e.hash,
        shortHash: e.shortHash,
        subject: e.subject,
        author: e.author,
        date: e.date,
      }));
    },
    async currentBranch(subPath?: string): Promise<string> {
      const dirPath = subPath && subPath !== '.' ? `${projectPath}/${subPath}` : projectPath;
      const info = await window.clubhouse.git.info(dirPath);
      return info.branch;
    },
    async diff(filePath: string, staged = false): Promise<string> {
      return window.clubhouse.git.diff(projectPath, filePath, staged);
    },
  };
}
