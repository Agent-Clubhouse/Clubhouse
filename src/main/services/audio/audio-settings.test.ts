import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app before import
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse' },
}));

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('not found'); }),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import * as fs from 'fs';
import { getSettings, saveSettings, DEFAULT_AUDIO_SETTINGS } from './audio-settings';

describe('audio-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const settings = getSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.sttBackend).toBe('whisper-local');
      expect(settings.ttsBackend).toBe('piper-local');
      expect(settings.activationMode).toBe('push-to-talk');
      expect(settings.routingMode).toBe('focused');
      expect(settings.ttsFilter.speakResponses).toBe(true);
      expect(settings.ttsFilter.speakToolSummaries).toBe(false);
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: true, sttBackend: 'deepgram-cloud', activationMode: 'voice-activated' }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.sttBackend).toBe('deepgram-cloud');
      expect(result.activationMode).toBe('voice-activated');
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid json');
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.sttBackend).toBe('whisper-local');
      expect(result.ttsBackend).toBe('piper-local');
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.sttBackend).toBe('whisper-local');
      expect(result.ttsBackend).toBe('piper-local');
      expect(result.activationMode).toBe('push-to-talk');
      expect(result.vadSensitivity).toBe(0.5);
      expect(result.globalKeybind).toBe('Space');
      expect(result.routingMode).toBe('focused');
      expect(result.ttsFilter).toEqual(DEFAULT_AUDIO_SETTINGS.ttsFilter);
    });
  });

  describe('saveSettings', () => {
    it('writes JSON to the correct path', () => {
      const settings = { ...DEFAULT_AUDIO_SETTINGS, enabled: true, sttBackend: 'deepgram-cloud' as const };
      saveSettings(settings);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
      const [writtenPath, data] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
      expect(writtenPath).toContain('audio-settings.json');
      const parsed = JSON.parse(data);
      expect(parsed.enabled).toBe(true);
      expect(parsed.sttBackend).toBe('deepgram-cloud');
    });
  });

  it('DEFAULT_AUDIO_SETTINGS is exported', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toBeDefined();
    expect(DEFAULT_AUDIO_SETTINGS.enabled).toBe(false);
  });
});
