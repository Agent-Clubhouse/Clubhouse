import { describe, it, expect, vi } from 'vitest';

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

import { getSettings, saveSettings, DEFAULT_AUDIO_SETTINGS } from './audio-settings';

describe('audio-settings', () => {
  it('returns defaults when no file exists', () => {
    const settings = getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.sttBackend).toBe('whisper-local');
    expect(settings.ttsBackend).toBe('piper-local');
    expect(settings.activationMode).toBe('push-to-talk');
    expect(settings.routingMode).toBe('focused');
    expect(settings.ttsFilter.speakResponses).toBe(true);
    expect(settings.ttsFilter.speakToolSummaries).toBe(false);
  });

  it('DEFAULT_AUDIO_SETTINGS is exported', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toBeDefined();
    expect(DEFAULT_AUDIO_SETTINGS.enabled).toBe(false);
  });
});
