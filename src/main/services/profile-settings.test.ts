import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Mock settings-store
const mockGet = vi.fn();
const mockSave = vi.fn();
vi.mock('./settings-store', () => ({
  createSettingsStore: vi.fn(() => ({
    get: (...args: unknown[]) => mockGet(...args),
    save: (...args: unknown[]) => mockSave(...args),
  })),
}));

import { getSettings, saveSettings, getProfiles, getProfile, saveProfile, deleteProfile, resolveProfileEnv } from './profile-settings';
import type { OrchestratorProfile } from '../../shared/types';

describe('profile-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns settings from store', () => {
      const settings = { profiles: [{ id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} }] };
      mockGet.mockReturnValue(settings);
      expect(getSettings()).toEqual(settings);
    });
  });

  describe('saveSettings', () => {
    it('writes settings to store', () => {
      const settings = { profiles: [] };
      saveSettings(settings);
      expect(mockSave).toHaveBeenCalledWith(settings);
    });
  });

  describe('getProfiles', () => {
    it('returns profiles array', () => {
      const profiles = [
        { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} },
        { id: 'p2', name: 'Personal', orchestrator: 'claude-code', env: {} },
      ];
      mockGet.mockReturnValue({ profiles });
      expect(getProfiles()).toEqual(profiles);
    });

    it('returns empty array when no profiles', () => {
      mockGet.mockReturnValue({ profiles: [] });
      expect(getProfiles()).toEqual([]);
    });
  });

  describe('getProfile', () => {
    it('returns matching profile by id', () => {
      const profile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} };
      mockGet.mockReturnValue({ profiles: [profile] });
      expect(getProfile('p1')).toEqual(profile);
    });

    it('returns undefined for non-existent id', () => {
      mockGet.mockReturnValue({ profiles: [] });
      expect(getProfile('nonexistent')).toBeUndefined();
    });
  });

  describe('saveProfile', () => {
    it('adds a new profile', () => {
      const existing = { profiles: [] as OrchestratorProfile[] };
      mockGet.mockReturnValue(existing);

      const newProfile: OrchestratorProfile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } };
      saveProfile(newProfile);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [newProfile] });
    });

    it('updates an existing profile', () => {
      const existing = {
        profiles: [{ id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} }],
      };
      mockGet.mockReturnValue(existing);

      const updated: OrchestratorProfile = { id: 'p1', name: 'Work Updated', orchestrator: 'claude-code', env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } };
      saveProfile(updated);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [updated] });
    });

    it('preserves other profiles when updating', () => {
      const p1: OrchestratorProfile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} };
      const p2: OrchestratorProfile = { id: 'p2', name: 'Personal', orchestrator: 'claude-code', env: {} };
      mockGet.mockReturnValue({ profiles: [p1, p2] });

      const updated = { ...p1, name: 'Work V2' };
      saveProfile(updated);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [updated, p2] });
    });
  });

  describe('deleteProfile', () => {
    it('removes profile by id', () => {
      const p1: OrchestratorProfile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} };
      const p2: OrchestratorProfile = { id: 'p2', name: 'Personal', orchestrator: 'claude-code', env: {} };
      mockGet.mockReturnValue({ profiles: [p1, p2] });

      deleteProfile('p1');

      expect(mockSave).toHaveBeenCalledWith({ profiles: [p2] });
    });

    it('no-ops when id does not exist', () => {
      const p1: OrchestratorProfile = { id: 'p1', name: 'Work', orchestrator: 'claude-code', env: {} };
      mockGet.mockReturnValue({ profiles: [p1] });

      deleteProfile('nonexistent');

      expect(mockSave).toHaveBeenCalledWith({ profiles: [p1] });
    });
  });

  describe('resolveProfileEnv', () => {
    it('expands ~ to home directory', () => {
      const home = os.homedir();
      const profile: OrchestratorProfile = {
        id: 'p1',
        name: 'Work',
        orchestrator: 'claude-code',
        env: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
      };

      const result = resolveProfileEnv(profile);
      expect(result.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-work'));
    });

    it('expands standalone ~', () => {
      const home = os.homedir();
      const profile: OrchestratorProfile = {
        id: 'p1',
        name: 'Work',
        orchestrator: 'claude-code',
        env: { SOME_VAR: '~' },
      };

      const result = resolveProfileEnv(profile);
      expect(result.SOME_VAR).toBe(home);
    });

    it('leaves absolute paths unchanged', () => {
      const profile: OrchestratorProfile = {
        id: 'p1',
        name: 'Work',
        orchestrator: 'codex-cli',
        env: { OPENAI_API_KEY: 'sk-12345' },
      };

      const result = resolveProfileEnv(profile);
      expect(result.OPENAI_API_KEY).toBe('sk-12345');
    });

    it('handles multiple env vars', () => {
      const home = os.homedir();
      const profile: OrchestratorProfile = {
        id: 'p1',
        name: 'Work',
        orchestrator: 'codex-cli',
        env: {
          OPENAI_API_KEY: 'sk-12345',
          OPENAI_BASE_URL: 'https://api.openai.com',
        },
      };

      const result = resolveProfileEnv(profile);
      expect(result.OPENAI_API_KEY).toBe('sk-12345');
      expect(result.OPENAI_BASE_URL).toBe('https://api.openai.com');
    });

    it('handles empty env', () => {
      const profile: OrchestratorProfile = {
        id: 'p1',
        name: 'Work',
        orchestrator: 'claude-code',
        env: {},
      };

      const result = resolveProfileEnv(profile);
      expect(result).toEqual({});
    });
  });
});
