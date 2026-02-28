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

const makeProfile = (overrides?: Partial<OrchestratorProfile>): OrchestratorProfile => ({
  id: 'p1',
  name: 'Work',
  orchestrators: {
    'claude-code': { env: {} },
  },
  ...overrides,
});

describe('profile-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns settings from store', () => {
      const settings = { profiles: [makeProfile()] };
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
        makeProfile(),
        makeProfile({ id: 'p2', name: 'Personal' }),
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
      const profile = makeProfile();
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

      const newProfile = makeProfile({
        orchestrators: {
          'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
        },
      });
      saveProfile(newProfile);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [newProfile] });
    });

    it('updates an existing profile', () => {
      const existing = {
        profiles: [makeProfile()],
      };
      mockGet.mockReturnValue(existing);

      const updated = makeProfile({
        name: 'Work Updated',
        orchestrators: {
          'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
        },
      });
      saveProfile(updated);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [updated] });
    });

    it('preserves other profiles when updating', () => {
      const p1 = makeProfile();
      const p2 = makeProfile({ id: 'p2', name: 'Personal' });
      mockGet.mockReturnValue({ profiles: [p1, p2] });

      const updated = { ...p1, name: 'Work V2' };
      saveProfile(updated);

      expect(mockSave).toHaveBeenCalledWith({ profiles: [updated, p2] });
    });
  });

  describe('deleteProfile', () => {
    it('removes profile by id', () => {
      const p1 = makeProfile();
      const p2 = makeProfile({ id: 'p2', name: 'Personal' });
      mockGet.mockReturnValue({ profiles: [p1, p2] });

      deleteProfile('p1');

      expect(mockSave).toHaveBeenCalledWith({ profiles: [p2] });
    });

    it('no-ops when id does not exist', () => {
      const p1 = makeProfile();
      mockGet.mockReturnValue({ profiles: [p1] });

      deleteProfile('nonexistent');

      expect(mockSave).toHaveBeenCalledWith({ profiles: [p1] });
    });
  });

  describe('resolveProfileEnv', () => {
    it('expands ~ to home directory for matching orchestrator', () => {
      const home = os.homedir();
      const profile = makeProfile({
        orchestrators: {
          'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
        },
      });

      const result = resolveProfileEnv(profile, 'claude-code');
      expect(result).toBeDefined();
      expect(result!.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-work'));
    });

    it('returns undefined for orchestrator not in profile', () => {
      const profile = makeProfile({
        orchestrators: {
          'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
        },
      });

      const result = resolveProfileEnv(profile, 'codex-cli');
      expect(result).toBeUndefined();
    });

    it('expands standalone ~', () => {
      const home = os.homedir();
      const profile = makeProfile({
        orchestrators: {
          'claude-code': { env: { SOME_VAR: '~' } },
        },
      });

      const result = resolveProfileEnv(profile, 'claude-code');
      expect(result).toBeDefined();
      expect(result!.SOME_VAR).toBe(home);
    });

    it('leaves absolute paths unchanged', () => {
      const profile = makeProfile({
        orchestrators: {
          'codex-cli': { env: { OPENAI_API_KEY: 'sk-12345' } },
        },
      });

      const result = resolveProfileEnv(profile, 'codex-cli');
      expect(result).toBeDefined();
      expect(result!.OPENAI_API_KEY).toBe('sk-12345');
    });

    it('handles multiple env vars', () => {
      const profile = makeProfile({
        orchestrators: {
          'codex-cli': { env: {
            OPENAI_API_KEY: 'sk-12345',
            OPENAI_BASE_URL: 'https://api.openai.com',
          }},
        },
      });

      const result = resolveProfileEnv(profile, 'codex-cli');
      expect(result).toBeDefined();
      expect(result!.OPENAI_API_KEY).toBe('sk-12345');
      expect(result!.OPENAI_BASE_URL).toBe('https://api.openai.com');
    });

    it('handles empty env for matching orchestrator', () => {
      const profile = makeProfile({
        orchestrators: {
          'claude-code': { env: {} },
        },
      });

      const result = resolveProfileEnv(profile, 'claude-code');
      expect(result).toEqual({});
    });

    it('handles profile with multiple orchestrators', () => {
      const home = os.homedir();
      const profile = makeProfile({
        orchestrators: {
          'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
          'codex-cli': { env: { OPENAI_API_KEY: 'sk-work' } },
        },
      });

      const ccResult = resolveProfileEnv(profile, 'claude-code');
      expect(ccResult).toBeDefined();
      expect(ccResult!.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-work'));

      const codexResult = resolveProfileEnv(profile, 'codex-cli');
      expect(codexResult).toBeDefined();
      expect(codexResult!.OPENAI_API_KEY).toBe('sk-work');

      const otherResult = resolveProfileEnv(profile, 'opencode');
      expect(otherResult).toBeUndefined();
    });
  });
});
