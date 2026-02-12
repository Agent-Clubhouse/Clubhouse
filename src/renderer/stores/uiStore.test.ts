import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

function getState() {
  return useUIStore.getState();
}

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      selectedGitFile: null,
    });
  });

  describe('selectedGitFile', () => {
    it('stores and retrieves file with worktreePath', () => {
      getState().setSelectedGitFile({
        path: 'src/index.ts',
        staged: false,
        worktreePath: '/repo/.clubhouse/agents/warm-ferret',
      });
      const file = getState().selectedGitFile;
      expect(file).toEqual({
        path: 'src/index.ts',
        staged: false,
        worktreePath: '/repo/.clubhouse/agents/warm-ferret',
      });
    });

    it('distinguishes same file path across different worktrees', () => {
      getState().setSelectedGitFile({
        path: 'src/app.ts',
        staged: true,
        worktreePath: '/repo',
      });
      expect(getState().selectedGitFile!.worktreePath).toBe('/repo');

      getState().setSelectedGitFile({
        path: 'src/app.ts',
        staged: true,
        worktreePath: '/repo/.clubhouse/agents/noble-quail',
      });
      expect(getState().selectedGitFile!.worktreePath).toBe('/repo/.clubhouse/agents/noble-quail');
    });

    it('clears to null', () => {
      getState().setSelectedGitFile({
        path: 'file.ts',
        staged: false,
        worktreePath: '/repo',
      });
      getState().setSelectedGitFile(null);
      expect(getState().selectedGitFile).toBeNull();
    });
  });
});
