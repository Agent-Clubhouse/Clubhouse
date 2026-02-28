import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHandle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockHandle(...args),
  },
}));

const mockGetSettings = vi.fn();
const mockSaveProfile = vi.fn();
const mockDeleteProfile = vi.fn();
vi.mock('../services/profile-settings', () => ({
  getSettings: () => mockGetSettings(),
  saveProfile: (...args: unknown[]) => mockSaveProfile(...args),
  deleteProfile: (...args: unknown[]) => mockDeleteProfile(...args),
}));

const mockGetProvider = vi.fn();
vi.mock('../orchestrators', () => ({
  getProvider: (id: string) => mockGetProvider(id),
}));

import { registerProfileHandlers } from './profile-handlers';

describe('profile-handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    mockHandle.mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler;
    });
    registerProfileHandlers();
  });

  it('registers all 4 IPC channels', () => {
    expect(mockHandle).toHaveBeenCalledTimes(4);
    expect(handlers['profile:get-settings']).toBeDefined();
    expect(handlers['profile:save-profile']).toBeDefined();
    expect(handlers['profile:delete-profile']).toBeDefined();
    expect(handlers['profile:get-profile-env-keys']).toBeDefined();
  });

  describe('GET_SETTINGS', () => {
    it('returns settings from profile-settings service', () => {
      const mockSettings = { profiles: [{ id: '1', name: 'Work', orchestrators: {} }] };
      mockGetSettings.mockReturnValue(mockSettings);

      const result = handlers['profile:get-settings']();
      expect(result).toEqual(mockSettings);
      expect(mockGetSettings).toHaveBeenCalledTimes(1);
    });

    it('returns empty profiles when none exist', () => {
      mockGetSettings.mockReturnValue({ profiles: [] });
      const result = handlers['profile:get-settings']();
      expect(result).toEqual({ profiles: [] });
    });
  });

  describe('SAVE_PROFILE', () => {
    it('delegates to profileSettings.saveProfile', () => {
      const profile = { id: 'p1', name: 'Work', orchestrators: { 'claude-code': { env: { KEY: 'val' } } } };
      handlers['profile:save-profile']({}, profile);

      expect(mockSaveProfile).toHaveBeenCalledWith(profile);
    });

    it('saves profile with empty orchestrators', () => {
      const profile = { id: 'p2', name: 'Empty', orchestrators: {} };
      handlers['profile:save-profile']({}, profile);

      expect(mockSaveProfile).toHaveBeenCalledWith(profile);
    });
  });

  describe('DELETE_PROFILE', () => {
    it('delegates to profileSettings.deleteProfile with profileId', () => {
      handlers['profile:delete-profile']({}, 'prof-123');

      expect(mockDeleteProfile).toHaveBeenCalledWith('prof-123');
    });

    it('handles empty string profileId', () => {
      handlers['profile:delete-profile']({}, '');
      expect(mockDeleteProfile).toHaveBeenCalledWith('');
    });
  });

  describe('GET_PROFILE_ENV_KEYS', () => {
    it('returns env keys from provider', () => {
      const mockProvider = { getProfileEnvKeys: vi.fn(() => ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) };
      mockGetProvider.mockReturnValue(mockProvider);

      const result = handlers['profile:get-profile-env-keys']({}, 'claude-code');
      expect(result).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']);
      expect(mockGetProvider).toHaveBeenCalledWith('claude-code');
    });

    it('returns empty array when provider not found', () => {
      mockGetProvider.mockReturnValue(undefined);

      const result = handlers['profile:get-profile-env-keys']({}, 'nonexistent');
      expect(result).toEqual([]);
    });

    it('returns empty array when provider returns empty keys', () => {
      const mockProvider = { getProfileEnvKeys: vi.fn(() => []) };
      mockGetProvider.mockReturnValue(mockProvider);

      const result = handlers['profile:get-profile-env-keys']({}, 'claude-code');
      expect(result).toEqual([]);
    });
  });
});
