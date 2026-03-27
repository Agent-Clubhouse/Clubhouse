import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFilesAPI, resolvePath } from './plugin-api-files';

// Mock dependencies
vi.mock('../stores/remoteProjectStore', () => ({
  isRemoteProjectId: (id: string) => id.startsWith('remote||'),
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const rest = id.slice('remote||'.length);
    const sep = rest.indexOf('||');
    if (sep === -1) return null;
    return { satelliteId: rest.slice(0, sep), agentId: rest.slice(sep + 2) };
  },
}));

vi.mock('./plugin-api-shared', () => ({
  hasPermission: () => true,
}));

vi.mock('./renderer-logger', () => ({
  rendererLog: vi.fn(),
}));

vi.mock('./plugin-store', () => ({
  usePluginStore: { getState: () => ({ pluginSettings: {} }) },
}));

describe('plugin-api-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.file = {
      readTree: vi.fn(async () => []),
      read: vi.fn(async () => ''),
      readBinary: vi.fn(async () => ''),
      write: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ size: 0, isFile: true, isDirectory: false })),
      rename: vi.fn(async () => {}),
      copy: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      showInFolder: vi.fn(async () => {}),
      search: vi.fn(async () => ({ results: [] })),
      watchStart: vi.fn(async () => {}),
      watchStop: vi.fn(async () => {}),
      onWatchEvent: vi.fn(),
      offWatchEvent: vi.fn(),
      openInEditor: vi.fn(async () => {}),
    } as any;
    window.clubhouse.annexClient = {
      ...window.clubhouse.annexClient,
      fileTree: vi.fn(async () => []),
      fileRead: vi.fn(async () => ''),
    } as any;
  });

  // ── resolvePath utility ────────────────────────────────────────────────

  describe('resolvePath', () => {
    it('resolves relative path against project path', () => {
      expect(resolvePath('/project', 'src/index.ts')).toBe('/project/src/index.ts');
    });

    it('passes through absolute paths', () => {
      expect(resolvePath('/project', '/project/src/index.ts')).toBe('/project/src/index.ts');
    });

    it('throws on path traversal via ../', () => {
      expect(() => resolvePath('/project', '../etc/passwd')).toThrow('Path traversal');
    });

    it('throws on path traversal via /..', () => {
      expect(() => resolvePath('/project', 'foo/../../etc')).toThrow('Path traversal');
    });

    it('throws when resolved path escapes project root', () => {
      expect(() => resolvePath('/project', '/etc/passwd')).toThrow('Path traversal');
    });
  });

  // ── Local project ─────────────────────────────────────────────────────

  describe('local project', () => {
    const localCtx = {
      pluginId: 'files',
      pluginPath: '/tmp',
      scope: 'project' as const,
      projectId: 'proj-1',
      projectPath: '/project',
      subscriptions: [],
      settings: {},
    };

    it('readTree() calls window.clubhouse.file.readTree with resolved path', async () => {
      const api = createFilesAPI(localCtx);
      await api.readTree('src');
      expect(window.clubhouse.file.readTree).toHaveBeenCalledWith('/project/src', undefined);
    });

    it('readTree() defaults to project root when no path specified', async () => {
      const api = createFilesAPI(localCtx);
      await api.readTree();
      expect(window.clubhouse.file.readTree).toHaveBeenCalledWith('/project/.', undefined);
    });

    it('readTree() passes options through', async () => {
      const api = createFilesAPI(localCtx);
      await api.readTree('.', { includeHidden: true, depth: 3 });
      expect(window.clubhouse.file.readTree).toHaveBeenCalledWith('/project/.', { includeHidden: true, depth: 3 });
    });

    it('readFile() calls window.clubhouse.file.read with resolved path', async () => {
      const api = createFilesAPI(localCtx);
      await api.readFile('src/index.ts');
      expect(window.clubhouse.file.read).toHaveBeenCalledWith('/project/src/index.ts');
    });

    it('readBinary() calls window.clubhouse.file.readBinary', async () => {
      const api = createFilesAPI(localCtx);
      await api.readBinary('image.png');
      expect(window.clubhouse.file.readBinary).toHaveBeenCalledWith('/project/image.png');
    });

    it('writeFile() calls window.clubhouse.file.write', async () => {
      const api = createFilesAPI(localCtx);
      await api.writeFile('src/index.ts', 'content');
      expect(window.clubhouse.file.write).toHaveBeenCalledWith('/project/src/index.ts', 'content');
    });

    it('stat() calls window.clubhouse.file.stat', async () => {
      const api = createFilesAPI(localCtx);
      await api.stat('src/index.ts');
      expect(window.clubhouse.file.stat).toHaveBeenCalledWith('/project/src/index.ts');
    });

    it('rename() calls window.clubhouse.file.rename with both paths', async () => {
      const api = createFilesAPI(localCtx);
      await api.rename('old.ts', 'new.ts');
      expect(window.clubhouse.file.rename).toHaveBeenCalledWith('/project/old.ts', '/project/new.ts');
    });

    it('copy() calls window.clubhouse.file.copy with both paths', async () => {
      const api = createFilesAPI(localCtx);
      await api.copy('src.ts', 'dest.ts');
      expect(window.clubhouse.file.copy).toHaveBeenCalledWith('/project/src.ts', '/project/dest.ts');
    });

    it('mkdir() calls window.clubhouse.file.mkdir', async () => {
      const api = createFilesAPI(localCtx);
      await api.mkdir('new-dir');
      expect(window.clubhouse.file.mkdir).toHaveBeenCalledWith('/project/new-dir');
    });

    it('delete() calls window.clubhouse.file.delete', async () => {
      const api = createFilesAPI(localCtx);
      await api.delete('old-file.ts');
      expect(window.clubhouse.file.delete).toHaveBeenCalledWith('/project/old-file.ts');
    });

    it('showInFolder() calls window.clubhouse.file.showInFolder', async () => {
      const api = createFilesAPI(localCtx);
      await api.showInFolder('src/index.ts');
      expect(window.clubhouse.file.showInFolder).toHaveBeenCalledWith('/project/src/index.ts');
    });

    it('search() calls window.clubhouse.file.search', async () => {
      const api = createFilesAPI(localCtx);
      await api.search('TODO', { caseSensitive: true });
      expect(window.clubhouse.file.search).toHaveBeenCalledWith('/project', 'TODO', { caseSensitive: true });
    });

    it('does not call annexClient methods', async () => {
      const api = createFilesAPI(localCtx);
      await api.readTree('src');
      await api.readFile('src/index.ts');
      expect(window.clubhouse.annexClient.fileTree).not.toHaveBeenCalled();
      expect(window.clubhouse.annexClient.fileRead).not.toHaveBeenCalled();
    });
  });

  // ── Remote project ────────────────────────────────────────────────────

  describe('remote project', () => {
    const remoteCtx = {
      pluginId: 'files',
      pluginPath: '/tmp',
      scope: 'project' as const,
      projectId: 'remote||sat-123||proj-abc',
      projectPath: '__remote__',
      subscriptions: [],
      settings: {},
    };

    // ── Supported operations ────────────────────────────────────────────

    it('readTree() routes through annexClient.fileTree', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readTree('src', { depth: 3, includeHidden: true });
      expect(window.clubhouse.annexClient.fileTree).toHaveBeenCalledWith(
        'sat-123',
        'proj-abc',
        { path: 'src', depth: 3, includeHidden: true },
      );
    });

    it('readTree() defaults to root path', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readTree();
      expect(window.clubhouse.annexClient.fileTree).toHaveBeenCalledWith(
        'sat-123',
        'proj-abc',
        { path: '.', depth: undefined, includeHidden: undefined },
      );
    });

    it('readFile() routes through annexClient.fileRead', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readFile('src/index.ts');
      expect(window.clubhouse.annexClient.fileRead).toHaveBeenCalledWith(
        'sat-123',
        'proj-abc',
        'src/index.ts',
      );
    });

    it('readTree() does not call local file.readTree', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readTree('src');
      expect(window.clubhouse.file.readTree).not.toHaveBeenCalled();
    });

    it('readFile() does not call local file.read', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readFile('src/index.ts');
      expect(window.clubhouse.file.read).not.toHaveBeenCalled();
    });

    it('returns file tree result from annexClient', async () => {
      const mockTree = [{ name: 'src', type: 'directory', children: [] }];
      vi.mocked(window.clubhouse.annexClient.fileTree).mockResolvedValue(mockTree);
      const api = createFilesAPI(remoteCtx);
      const result = await api.readTree();
      expect(result).toEqual(mockTree);
    });

    it('returns file content from annexClient', async () => {
      vi.mocked(window.clubhouse.annexClient.fileRead).mockResolvedValue('file content here');
      const api = createFilesAPI(remoteCtx);
      const result = await api.readFile('README.md');
      expect(result).toBe('file content here');
    });

    // ── Unsupported operations throw clear errors ───────────────────────

    it('readBinary() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.readBinary('image.png')).toThrow('not supported for remote projects');
    });

    it('writeFile() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.writeFile('file.ts', 'content')).toThrow('not supported for remote projects');
    });

    it('stat() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.stat('file.ts')).toThrow('not supported for remote projects');
    });

    it('rename() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.rename('old.ts', 'new.ts')).toThrow('not supported for remote projects');
    });

    it('copy() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.copy('src.ts', 'dest.ts')).toThrow('not supported for remote projects');
    });

    it('mkdir() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.mkdir('new-dir')).toThrow('not supported for remote projects');
    });

    it('delete() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.delete('file.ts')).toThrow('not supported for remote projects');
    });

    it('showInFolder() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.showInFolder('file.ts')).toThrow('not supported for remote projects');
    });

    it('search() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.search('TODO')).toThrow('not supported for remote projects');
    });

    it('forRoot() throws "not supported" for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(() => api.forRoot('myRoot')).toThrow('not supported for remote projects');
    });

    // ── watch returns no-op disposable ──────────────────────────────────

    it('watch() returns a disposable without throwing', () => {
      const api = createFilesAPI(remoteCtx);
      const disposable = api.watch('**/*', vi.fn());
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
      // Should not throw
      disposable.dispose();
    });

    it('watch() does not call local file.watchStart', () => {
      const api = createFilesAPI(remoteCtx);
      api.watch('**/*', vi.fn());
      expect(window.clubhouse.file.watchStart).not.toHaveBeenCalled();
    });

    // ── dataDir is still available for remote ───────────────────────────

    it('provides a dataDir path even for remote projects', () => {
      const api = createFilesAPI(remoteCtx);
      expect(api.dataDir).toContain('files');
      expect(api.dataDir).toContain('plugin-data');
    });

    // ── No local file methods called for any remote operation ───────────

    it('no local file methods are called for supported remote operations', async () => {
      const api = createFilesAPI(remoteCtx);
      await api.readTree('src');
      await api.readFile('src/index.ts');
      api.watch('**/*', vi.fn());

      expect(window.clubhouse.file.readTree).not.toHaveBeenCalled();
      expect(window.clubhouse.file.read).not.toHaveBeenCalled();
      expect(window.clubhouse.file.readBinary).not.toHaveBeenCalled();
      expect(window.clubhouse.file.write).not.toHaveBeenCalled();
      expect(window.clubhouse.file.stat).not.toHaveBeenCalled();
      expect(window.clubhouse.file.rename).not.toHaveBeenCalled();
      expect(window.clubhouse.file.copy).not.toHaveBeenCalled();
      expect(window.clubhouse.file.mkdir).not.toHaveBeenCalled();
      expect(window.clubhouse.file.delete).not.toHaveBeenCalled();
      expect(window.clubhouse.file.showInFolder).not.toHaveBeenCalled();
      expect(window.clubhouse.file.search).not.toHaveBeenCalled();
      expect(window.clubhouse.file.watchStart).not.toHaveBeenCalled();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('throws when projectPath is missing', () => {
      expect(() => createFilesAPI({
        pluginId: 'files',
        pluginPath: '/tmp',
        scope: 'project',
        projectId: 'proj-1',
        projectPath: '',
        subscriptions: [],
        settings: {},
      })).toThrow('FilesAPI requires projectPath');
    });

    it('throws when remote project ID is malformed', () => {
      expect(() => createFilesAPI({
        pluginId: 'files',
        pluginPath: '/tmp',
        scope: 'project',
        projectId: 'remote||invalid',
        projectPath: '__remote__',
        subscriptions: [],
        settings: {},
      })).toThrow('Invalid remote project ID');
    });
  });
});
