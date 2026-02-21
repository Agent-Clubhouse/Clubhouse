import { describe, it, expect, vi, beforeEach } from 'vitest';

// Override the default setup-renderer stub with controllable mocks
const mockGetSettings = vi.fn(async () => ({
  enabled: false,
  sttBackend: 'whisper-local' as const,
  ttsBackend: 'piper-local' as const,
  activationMode: 'push-to-talk' as const,
  ttsFilter: { speakResponses: true, speakToolSummaries: false, speakErrors: true, speakStatus: false },
  routingMode: 'focused' as const,
}));
const mockSaveSettings = vi.fn(async () => {});
const mockGetVoices = vi.fn(async () => []);

Object.defineProperty(window, 'clubhouse', {
  configurable: true,
  get: () => ({
    platform: 'darwin',
    audio: {
      getSettings: mockGetSettings,
      saveSettings: mockSaveSettings,
      getVoices: mockGetVoices,
      startRecording: vi.fn(async () => {}),
      stopRecording: vi.fn(async () => {}),
      sendRecordingData: vi.fn(),
      speak: vi.fn(async () => {}),
      cancelSpeech: vi.fn(),
      onSpeakAudio: () => vi.fn(),
      onSpeakDone: () => vi.fn(),
      onTranscription: () => vi.fn(),
      onModelDownloadProgress: () => vi.fn(),
    },
    pty: { write: vi.fn(), resize: vi.fn(), getBuffer: vi.fn(async () => ''), onData: () => vi.fn(), onExit: () => vi.fn() },
  }),
});

import { useAudioStore } from './audioStore';

describe('audioStore', () => {
  beforeEach(() => {
    mockGetSettings.mockReset().mockResolvedValue({
      enabled: false,
      sttBackend: 'whisper-local',
      ttsBackend: 'piper-local',
      activationMode: 'push-to-talk',
      ttsFilter: { speakResponses: true, speakToolSummaries: false, speakErrors: true, speakStatus: false },
      routingMode: 'focused',
    });
    mockSaveSettings.mockReset();
    mockGetVoices.mockReset().mockResolvedValue([]);
    useAudioStore.setState({
      settings: null,
      recording: false,
      transcribing: false,
      speaking: false,
      speakingAgentId: null,
      availableVoices: [],
      agentVoiceAssignments: {},
      micPermission: 'unknown',
    });
  });

  it('starts with null settings', () => {
    const state = useAudioStore.getState();
    expect(state.settings).toBeNull();
    expect(state.recording).toBe(false);
    expect(state.transcribing).toBe(false);
    expect(state.speaking).toBe(false);
    expect(state.speakingAgentId).toBeNull();
  });

  it('loadSettings fetches from IPC', async () => {
    await useAudioStore.getState().loadSettings();
    const state = useAudioStore.getState();
    expect(mockGetSettings).toHaveBeenCalled();
    expect(state.settings).not.toBeNull();
    expect(state.settings!.sttBackend).toBe('whisper-local');
    expect(state.settings!.ttsBackend).toBe('piper-local');
    expect(state.settings!.activationMode).toBe('push-to-talk');
  });

  it('saveSettings merges and persists via IPC', async () => {
    // Load initial settings first
    await useAudioStore.getState().loadSettings();

    // Save partial update
    await useAudioStore.getState().saveSettings({ enabled: true });

    const state = useAudioStore.getState();
    expect(state.settings!.enabled).toBe(true);
    // Other fields should be preserved
    expect(state.settings!.sttBackend).toBe('whisper-local');
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, sttBackend: 'whisper-local' }),
    );
  });

  it('saveSettings does nothing when settings are null', async () => {
    // Don't load settings, so they remain null
    await useAudioStore.getState().saveSettings({ enabled: true });
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(useAudioStore.getState().settings).toBeNull();
  });

  it('setRecording updates state', () => {
    useAudioStore.getState().setRecording(true);
    expect(useAudioStore.getState().recording).toBe(true);

    useAudioStore.getState().setRecording(false);
    expect(useAudioStore.getState().recording).toBe(false);
  });

  it('setTranscribing updates state', () => {
    useAudioStore.getState().setTranscribing(true);
    expect(useAudioStore.getState().transcribing).toBe(true);

    useAudioStore.getState().setTranscribing(false);
    expect(useAudioStore.getState().transcribing).toBe(false);
  });

  it('setSpeaking updates speaking and agentId', () => {
    useAudioStore.getState().setSpeaking(true, 'agent-1');
    expect(useAudioStore.getState().speaking).toBe(true);
    expect(useAudioStore.getState().speakingAgentId).toBe('agent-1');
  });

  it('setSpeaking clears agentId when speaking is false', () => {
    useAudioStore.getState().setSpeaking(true, 'agent-1');
    useAudioStore.getState().setSpeaking(false);
    expect(useAudioStore.getState().speaking).toBe(false);
    expect(useAudioStore.getState().speakingAgentId).toBeNull();
  });

  it('setSpeaking without agentId sets speakingAgentId to null', () => {
    useAudioStore.getState().setSpeaking(true);
    expect(useAudioStore.getState().speaking).toBe(true);
    expect(useAudioStore.getState().speakingAgentId).toBeNull();
  });

  it('loadSettings handles IPC failure gracefully', async () => {
    mockGetSettings.mockRejectedValue(new Error('IPC fail'));
    await useAudioStore.getState().loadSettings();
    expect(useAudioStore.getState().settings).toBeNull();
  });

  it('saveSettings rolls back on IPC failure', async () => {
    await useAudioStore.getState().loadSettings();
    const original = useAudioStore.getState().settings;
    mockSaveSettings.mockRejectedValue(new Error('IPC fail'));
    await useAudioStore.getState().saveSettings({ enabled: true });
    expect(useAudioStore.getState().settings).toEqual(original);
  });

  it('loadVoices handles IPC failure gracefully', async () => {
    mockGetVoices.mockRejectedValue(new Error('IPC fail'));
    await useAudioStore.getState().loadVoices();
    expect(useAudioStore.getState().availableVoices).toEqual([]);
  });

  it('loadVoices fetches and stores available voices', async () => {
    const mockVoices = [
      { voiceId: 'v1', voiceName: 'Voice One', language: 'en' },
      { voiceId: 'v2', voiceName: 'Voice Two', language: 'en', gender: 'female' as const },
    ];
    mockGetVoices.mockResolvedValue(mockVoices);

    await useAudioStore.getState().loadVoices();

    const state = useAudioStore.getState();
    expect(state.availableVoices).toEqual(mockVoices);
    expect(mockGetVoices).toHaveBeenCalled();
  });

  describe('checkMicPermission', () => {
    const mockQuery = vi.fn();

    beforeEach(() => {
      mockQuery.mockReset();
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: mockQuery },
      });
    });

    it('starts with unknown micPermission', () => {
      expect(useAudioStore.getState().micPermission).toBe('unknown');
    });

    it('sets micPermission to granted when permissions API reports granted', async () => {
      const mockStatus = { state: 'granted', onchange: null };
      mockQuery.mockResolvedValue(mockStatus);

      await useAudioStore.getState().checkMicPermission();

      expect(useAudioStore.getState().micPermission).toBe('granted');
    });

    it('sets micPermission to denied when permissions API reports denied', async () => {
      const mockStatus = { state: 'denied', onchange: null };
      mockQuery.mockResolvedValue(mockStatus);

      await useAudioStore.getState().checkMicPermission();

      expect(useAudioStore.getState().micPermission).toBe('denied');
    });

    it('sets micPermission to prompt when permissions API reports prompt', async () => {
      const mockStatus = { state: 'prompt', onchange: null };
      mockQuery.mockResolvedValue(mockStatus);

      await useAudioStore.getState().checkMicPermission();

      expect(useAudioStore.getState().micPermission).toBe('prompt');
    });

    it('falls back to unknown when permissions API is not supported', async () => {
      mockQuery.mockRejectedValue(new TypeError('not supported'));

      await useAudioStore.getState().checkMicPermission();

      expect(useAudioStore.getState().micPermission).toBe('unknown');
    });

    it('updates micPermission when status changes via onchange', async () => {
      let changeHandler: (() => void) | null = null;
      const mockStatus = {
        state: 'prompt',
        set onchange(fn: (() => void) | null) { changeHandler = fn; },
        get onchange() { return changeHandler; },
      };
      mockQuery.mockResolvedValue(mockStatus);

      await useAudioStore.getState().checkMicPermission();
      expect(useAudioStore.getState().micPermission).toBe('prompt');

      // Simulate permission change
      (mockStatus as { state: string }).state = 'granted';
      changeHandler!();
      expect(useAudioStore.getState().micPermission).toBe('granted');
    });
  });
});
