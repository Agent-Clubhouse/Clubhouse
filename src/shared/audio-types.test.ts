import { describe, it, expect } from 'vitest';
import { IPC } from './ipc-channels';
import type {
  STTBackendId,
  TTSBackendId,
  OutputKind,
  VoiceConfig,
  VoiceInfo,
  TTSFilter,
  AudioSettings,
  STTOpts,
  STTResult,
  ModelInfo,
  Agent,
  DurableAgentConfig,
  SettingsSubPage,
} from './types';

describe('Audio types', () => {
  it('VoiceConfig is assignable with valid data', () => {
    const cfg: VoiceConfig = {
      voiceId: 'piper-en-us-1',
      voiceName: 'Amy',
      backend: 'piper-local',
      speed: 1.2,
    };
    expect(cfg.voiceId).toBe('piper-en-us-1');
    expect(cfg.backend).toBe('piper-local');
  });

  it('VoiceInfo accepts optional fields', () => {
    const info: VoiceInfo = {
      voiceId: 'v1',
      voiceName: 'Voice One',
      language: 'en',
    };
    expect(info.gender).toBeUndefined();
    expect(info.sampleAudioUrl).toBeUndefined();
  });

  it('TTSFilter has all boolean fields', () => {
    const filter: TTSFilter = {
      speakResponses: true,
      speakToolSummaries: false,
      speakErrors: true,
      speakStatus: false,
    };
    expect(filter.speakResponses).toBe(true);
    expect(filter.speakToolSummaries).toBe(false);
  });

  it('AudioSettings accepts both activation modes', () => {
    const base: AudioSettings = {
      enabled: true,
      sttBackend: 'whisper-local',
      ttsBackend: 'piper-local',
      activationMode: 'push-to-talk',
      ttsFilter: {
        speakResponses: true,
        speakToolSummaries: true,
        speakErrors: false,
        speakStatus: false,
      },
      routingMode: 'focused',
    };
    expect(base.activationMode).toBe('push-to-talk');

    const vad: AudioSettings = { ...base, activationMode: 'vad', vadSensitivity: 0.7 };
    expect(vad.activationMode).toBe('vad');
    expect(vad.vadSensitivity).toBe(0.7);
  });

  it('STTOpts and STTResult are well-formed', () => {
    const opts: STTOpts = { language: 'en', sampleRate: 16000, channels: 1 };
    expect(opts.sampleRate).toBe(16000);

    const result: STTResult = { text: 'hello', durationMs: 1200, confidence: 0.95 };
    expect(result.text).toBe('hello');
  });

  it('ModelInfo distinguishes stt and tts', () => {
    const sttModel: ModelInfo = {
      id: 'whisper-tiny',
      name: 'Whisper Tiny',
      kind: 'stt',
      sizeBytes: 75_000_000,
      language: 'en',
      downloaded: false,
      remoteUrl: 'https://example.com/whisper-tiny.bin',
      sha256: 'abc123',
    };
    expect(sttModel.kind).toBe('stt');

    const ttsModel: ModelInfo = { ...sttModel, id: 'piper-en', kind: 'tts' };
    expect(ttsModel.kind).toBe('tts');
  });

  it('Agent.voiceConfig is optional', () => {
    const agent: Partial<Agent> = { id: 'a1', name: 'test' };
    expect(agent.voiceConfig).toBeUndefined();

    const agentWithVoice: Partial<Agent> = {
      ...agent,
      voiceConfig: { voiceId: 'v1', voiceName: 'Amy', backend: 'piper-local' },
    };
    expect(agentWithVoice.voiceConfig?.voiceId).toBe('v1');
  });

  it('DurableAgentConfig.voiceId is optional', () => {
    const cfg: Partial<DurableAgentConfig> = { id: 'd1', name: 'durable' };
    expect(cfg.voiceId).toBeUndefined();

    const cfgWithVoice: Partial<DurableAgentConfig> = { ...cfg, voiceId: 'v1' };
    expect(cfgWithVoice.voiceId).toBe('v1');
  });

  it('SettingsSubPage includes audio', () => {
    const page: SettingsSubPage = 'audio';
    expect(page).toBe('audio');
  });

  it('STTBackendId and TTSBackendId accept known and custom strings', () => {
    const stt1: STTBackendId = 'whisper-local';
    const stt2: STTBackendId = 'parakeet-local';
    const stt3: STTBackendId = 'openai-cloud';
    const sttCustom: STTBackendId = 'my-custom-stt';
    expect([stt1, stt2, stt3, sttCustom]).toHaveLength(4);

    const tts1: TTSBackendId = 'piper-local';
    const tts2: TTSBackendId = 'openai-cloud';
    const ttsCustom: TTSBackendId = 'my-custom-tts';
    expect([tts1, tts2, ttsCustom]).toHaveLength(3);
  });

  it('OutputKind covers all variants', () => {
    const kinds: OutputKind[] = ['response', 'tool_summary', 'error', 'status_change'];
    expect(kinds).toHaveLength(4);
  });
});

describe('AUDIO IPC channels', () => {
  it('IPC.AUDIO section exists', () => {
    expect(IPC.AUDIO).toBeDefined();
    expect(typeof IPC.AUDIO).toBe('object');
  });

  it('contains all expected channel keys', () => {
    const expectedKeys = [
      'GET_SETTINGS',
      'SAVE_SETTINGS',
      'START_RECORDING',
      'STOP_RECORDING',
      'RECORDING_DATA',
      'TRANSCRIPTION',
      'SPEAK',
      'SPEAK_AUDIO',
      'SPEAK_DONE',
      'CANCEL_SPEECH',
      'GET_VOICES',
      'GET_MODELS',
      'DOWNLOAD_MODEL',
      'MODEL_DOWNLOAD_PROGRESS',
      'ROUTE_SPEECH',
    ];
    for (const key of expectedKeys) {
      expect(IPC.AUDIO).toHaveProperty(key);
    }
  });

  it('all channel values are prefixed with "audio:"', () => {
    for (const value of Object.values(IPC.AUDIO)) {
      expect(value).toMatch(/^audio:/);
    }
  });

  it('channel values match expected strings', () => {
    expect(IPC.AUDIO.GET_SETTINGS).toBe('audio:get-settings');
    expect(IPC.AUDIO.SAVE_SETTINGS).toBe('audio:save-settings');
    expect(IPC.AUDIO.START_RECORDING).toBe('audio:start-recording');
    expect(IPC.AUDIO.STOP_RECORDING).toBe('audio:stop-recording');
    expect(IPC.AUDIO.RECORDING_DATA).toBe('audio:recording-data');
    expect(IPC.AUDIO.TRANSCRIPTION).toBe('audio:transcription');
    expect(IPC.AUDIO.SPEAK).toBe('audio:speak');
    expect(IPC.AUDIO.SPEAK_AUDIO).toBe('audio:speak-audio');
    expect(IPC.AUDIO.SPEAK_DONE).toBe('audio:speak-done');
    expect(IPC.AUDIO.CANCEL_SPEECH).toBe('audio:cancel-speech');
    expect(IPC.AUDIO.GET_VOICES).toBe('audio:get-voices');
    expect(IPC.AUDIO.GET_MODELS).toBe('audio:get-models');
    expect(IPC.AUDIO.DOWNLOAD_MODEL).toBe('audio:download-model');
    expect(IPC.AUDIO.MODEL_DOWNLOAD_PROGRESS).toBe('audio:model-download-progress');
    expect(IPC.AUDIO.ROUTE_SPEECH).toBe('audio:route-speech');
  });
});
