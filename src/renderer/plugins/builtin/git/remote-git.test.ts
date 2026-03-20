import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock remoteProjectStore before importing
vi.mock('../../../stores/remoteProjectStore', () => ({
  isRemoteProjectId: (id: string) => id.startsWith('remote||'),
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const rest = id.slice('remote||'.length);
    const sep = rest.indexOf('||');
    if (sep === -1) return null;
    return { satelliteId: rest.slice(0, sep), agentId: rest.slice(sep + 2) };
  },
}));

import { createGitOps } from './remote-git';

describe('createGitOps', () => {
  beforeEach(() => {
    // Reset window.clubhouse mock
    (globalThis as any).window = {
      clubhouse: {
        git: {
          info: vi.fn().mockResolvedValue({ branch: 'main', status: [] }),
          log: vi.fn().mockResolvedValue([]),
          diff: vi.fn().mockResolvedValue({ original: '', modified: '' }),
          commitDiff: vi.fn().mockResolvedValue({ original: '', modified: '' }),
          showCommit: vi.fn().mockResolvedValue({ files: [] }),
          stage: vi.fn().mockResolvedValue({ ok: true }),
          unstage: vi.fn().mockResolvedValue({ ok: true }),
          stageAll: vi.fn().mockResolvedValue({ ok: true }),
          unstageAll: vi.fn().mockResolvedValue({ ok: true }),
          commit: vi.fn().mockResolvedValue({ ok: true }),
          push: vi.fn().mockResolvedValue({ ok: true }),
          pull: vi.fn().mockResolvedValue({ ok: true }),
          checkout: vi.fn().mockResolvedValue({ ok: true }),
          stash: vi.fn().mockResolvedValue({ ok: true }),
          stashPop: vi.fn().mockResolvedValue({ ok: true }),
        },
        annexClient: {
          gitOperation: vi.fn().mockResolvedValue({}),
        },
      },
    };
  });

  describe('local project', () => {
    it('routes info through window.clubhouse.git.info', async () => {
      const git = createGitOps('/my/project', 'proj-123');
      await git.info();
      expect(window.clubhouse.git.info).toHaveBeenCalledWith('/my/project');
    });

    it('routes log through window.clubhouse.git.log', async () => {
      const git = createGitOps('/my/project', 'proj-123');
      await git.log(50, 0);
      expect(window.clubhouse.git.log).toHaveBeenCalledWith('/my/project', 50, 0);
    });

    it('routes stage through window.clubhouse.git.stage', async () => {
      const git = createGitOps('/my/project', 'proj-123');
      await git.stage('src/index.ts');
      expect(window.clubhouse.git.stage).toHaveBeenCalledWith('/my/project', 'src/index.ts');
    });

    it('routes commit through window.clubhouse.git.commit', async () => {
      const git = createGitOps('/my/project', 'proj-123');
      await git.commit('fix bug');
      expect(window.clubhouse.git.commit).toHaveBeenCalledWith('/my/project', 'fix bug');
    });

    it('routes diff through window.clubhouse.git.diff', async () => {
      const git = createGitOps('/my/project', 'proj-123');
      await git.diff('src/index.ts', true);
      expect(window.clubhouse.git.diff).toHaveBeenCalledWith('/my/project', 'src/index.ts', true);
    });
  });

  describe('remote project', () => {
    const remoteProjectId = 'remote||sat-abc||proj-xyz';

    it('routes info through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.info();
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'info' },
      );
    });

    it('routes log through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.log(50, 0);
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'log', limit: 50, offset: 0 },
      );
    });

    it('routes stage through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.stage('src/index.ts');
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'stage', path: 'src/index.ts' },
      );
    });

    it('routes commit through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.commit('fix bug');
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'commit', message: 'fix bug' },
      );
    });

    it('routes diff through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.diff('src/index.ts', true);
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'diff', file: 'src/index.ts', staged: true },
      );
    });

    it('routes push through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.push();
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'push' },
      );
    });

    it('routes checkout through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.checkout('feature/new');
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'checkout', branch: 'feature/new' },
      );
    });

    it('routes showCommit through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.showCommit('abc123');
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'show-commit', hash: 'abc123' },
      );
    });

    it('routes commitDiff through annexClient.gitOperation', async () => {
      const git = createGitOps('__remote__', remoteProjectId);
      await git.commitDiff('abc123', 'src/file.ts');
      expect(window.clubhouse.annexClient.gitOperation).toHaveBeenCalledWith(
        'sat-abc', 'proj-xyz', { operation: 'commit-diff', hash: 'abc123', file: 'src/file.ts' },
      );
    });
  });

  it('treats undefined projectId as local', async () => {
    const git = createGitOps('/my/project');
    await git.info();
    expect(window.clubhouse.git.info).toHaveBeenCalledWith('/my/project');
  });
});
