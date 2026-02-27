import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProfileStore } from './profileStore';

describe('profileStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProfileStore.setState({ profiles: [] });
    (window as any).clubhouse.profile = {
      getSettings: vi.fn(),
      saveProfile: vi.fn(),
      deleteProfile: vi.fn(),
      getProfileEnvKeys: vi.fn(),
    };
  });

  describe('initial state', () => {
    it('starts with empty profiles', () => {
      expect(useProfileStore.getState().profiles).toEqual([]);
    });
  });

  describe('loadProfiles', () => {
    it('loads profiles from IPC', async () => {
      const profiles = [
        { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
      ];
      (window as any).clubhouse.profile.getSettings.mockResolvedValue({ profiles });

      await useProfileStore.getState().loadProfiles();

      expect(useProfileStore.getState().profiles).toEqual(profiles);
    });

    it('handles missing profiles field gracefully', async () => {
      (window as any).clubhouse.profile.getSettings.mockResolvedValue({});

      await useProfileStore.getState().loadProfiles();

      expect(useProfileStore.getState().profiles).toEqual([]);
    });

    it('handles IPC error gracefully', async () => {
      (window as any).clubhouse.profile.getSettings.mockRejectedValue(new Error('IPC failed'));

      await useProfileStore.getState().loadProfiles();

      expect(useProfileStore.getState().profiles).toEqual([]);
    });
  });

  describe('saveProfile', () => {
    it('calls IPC and reloads', async () => {
      const profile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} };
      (window as any).clubhouse.profile.saveProfile.mockResolvedValue(undefined);
      (window as any).clubhouse.profile.getSettings.mockResolvedValue({ profiles: [profile] });

      await useProfileStore.getState().saveProfile(profile);

      expect((window as any).clubhouse.profile.saveProfile).toHaveBeenCalledWith(profile);
      expect(useProfileStore.getState().profiles).toEqual([profile]);
    });
  });

  describe('deleteProfile', () => {
    it('calls IPC and reloads', async () => {
      (window as any).clubhouse.profile.deleteProfile.mockResolvedValue(undefined);
      (window as any).clubhouse.profile.getSettings.mockResolvedValue({ profiles: [] });

      await useProfileStore.getState().deleteProfile('p1');

      expect((window as any).clubhouse.profile.deleteProfile).toHaveBeenCalledWith('p1');
      expect(useProfileStore.getState().profiles).toEqual([]);
    });
  });

  describe('getProfilesForOrchestrator', () => {
    it('filters profiles by orchestrator', () => {
      useProfileStore.setState({
        profiles: [
          { id: 'p1', name: 'Work CC', orchestrator: 'claude-code', env: {} },
          { id: 'p2', name: 'Personal CC', orchestrator: 'claude-code', env: {} },
          { id: 'p3', name: 'Work Codex', orchestrator: 'codex-cli', env: {} },
        ],
      });

      const ccProfiles = useProfileStore.getState().getProfilesForOrchestrator('claude-code');
      expect(ccProfiles).toHaveLength(2);
      expect(ccProfiles[0].name).toBe('Work CC');
      expect(ccProfiles[1].name).toBe('Personal CC');
    });

    it('returns empty array when no matches', () => {
      useProfileStore.setState({
        profiles: [
          { id: 'p1', name: 'Work CC', orchestrator: 'claude-code', env: {} },
        ],
      });

      const result = useProfileStore.getState().getProfilesForOrchestrator('opencode');
      expect(result).toEqual([]);
    });
  });

  describe('getProfileEnvKeys', () => {
    it('delegates to IPC', async () => {
      (window as any).clubhouse.profile.getProfileEnvKeys.mockResolvedValue(['CLAUDE_CONFIG_DIR']);

      const keys = await useProfileStore.getState().getProfileEnvKeys('claude-code');

      expect((window as any).clubhouse.profile.getProfileEnvKeys).toHaveBeenCalledWith('claude-code');
      expect(keys).toEqual(['CLAUDE_CONFIG_DIR']);
    });
  });
});
