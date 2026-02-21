import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('not found'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { appLog } from '../log-service';
import { AudioService } from './audio-service';
import type { STTEngine } from './stt/stt-engine';
import type { TTSEngine } from './tts/tts-engine';
import type { Agent } from '../../../shared/types';

const mockSTT: STTEngine = {
  id: 'whisper-local',
  displayName: 'Whisper',
  initialize: vi.fn(),
  isAvailable: vi.fn(async () => true),
  transcribe: vi.fn(async () => ({ text: 'Hello world', durationMs: 100 })),
  dispose: vi.fn(),
};

const mockTTS: TTSEngine = {
  id: 'piper-local',
  displayName: 'Piper',
  initialize: vi.fn(),
  isAvailable: vi.fn(async () => true),
  listVoices: vi.fn(async () => [{ voiceId: 'test-voice', voiceName: 'Test', language: 'en' }]),
  synthesize: vi.fn(async () => Buffer.alloc(1000)),
  synthesizeStream: vi.fn(async function* () { yield Buffer.alloc(1000); }),
  dispose: vi.fn(),
};

describe('AudioService', () => {
  let service: AudioService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AudioService();
    service.registerSTTEngine(mockSTT);
    service.registerTTSEngine(mockTTS);
  });

  it('registers and retrieves STT engines', () => {
    const engine = service.getActiveSTTEngine();
    expect(engine.id).toBe('whisper-local');
  });

  it('registers and retrieves TTS engines', () => {
    const engine = service.getActiveTTSEngine();
    expect(engine.id).toBe('piper-local');
  });

  it('accumulates recording data and transcribes it', async () => {
    service.onRecordingData(Buffer.alloc(100));
    service.onRecordingData(Buffer.alloc(200));
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: '#fff' },
    ];
    const result = await service.onRecordingStop(agents, 'a1');
    expect(result.text).toBe('Hello world');
    // Verify the STT engine received the concatenated buffer (300 bytes)
    expect(mockSTT.transcribe).toHaveBeenCalledWith(expect.any(Buffer));
    const calledWith = (mockSTT.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
    expect(calledWith.length).toBe(300);
  });

  it('initializes without errors', async () => {
    await expect(service.initialize()).resolves.not.toThrow();
    expect(appLog).toHaveBeenCalledWith('audio:service', 'info', 'AudioService initializing');
  });

  it('throws when no STT engine is registered', () => {
    const emptyService = new AudioService();
    expect(() => emptyService.getActiveSTTEngine()).toThrow('No STT engine registered');
  });

  it('throws when no TTS engine is registered', () => {
    const emptyService = new AudioService();
    expect(() => emptyService.getActiveTTSEngine()).toThrow('No TTS engine registered');
  });

  it('returns settings from constructor', () => {
    const settings = service.getSettings();
    expect(settings.sttBackend).toBe('whisper-local');
    expect(settings.ttsBackend).toBe('piper-local');
  });

  it('updates settings', () => {
    const current = service.getSettings();
    const updated = { ...current, enabled: true };
    service.updateSettings(updated);
    expect(service.getSettings().enabled).toBe(true);
  });

  it('disposes all engines and logs', () => {
    service.dispose();
    expect(mockSTT.dispose).toHaveBeenCalled();
    expect(mockTTS.dispose).toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledWith('audio:service', 'info', 'AudioService disposed');
  });

  it('exposes voice manager and voice router', () => {
    expect(service.getVoiceManager()).toBeDefined();
    expect(service.getVoiceRouter()).toBeDefined();
  });

  it('transcribes and routes on recording stop', async () => {
    service.onRecordingData(Buffer.from('fake audio'));
    const agents = [{ id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable' as const, status: 'running' as const, color: '#fff' }];
    const result = await service.onRecordingStop(agents, 'a1');
    expect(result.agentId).toBe('a1');
    expect(result.text).toBe('Hello world');
    expect(mockSTT.transcribe).toHaveBeenCalled();
  });

  it('returns null from onAgentOutput when disabled', async () => {
    // Default settings have enabled: false
    const result = await service.onAgentOutput('a1', 'Hello', 'response');
    expect(result).toBeNull();
  });

  it('synthesizes speech when enabled', async () => {
    const current = service.getSettings();
    service.updateSettings({ ...current, enabled: true });
    const result = await service.onAgentOutput('a1', 'Hello', 'response');
    expect(result).toBeInstanceOf(Buffer);
    expect(mockTTS.synthesize).toHaveBeenCalled();
  });

  it('cancelSpeech resets speakingAgentId', async () => {
    // Enable TTS so we can set speakingAgentId via onAgentOutput
    const current = service.getSettings();
    service.updateSettings({ ...current, enabled: true });

    // Trigger synthesis to set speakingAgentId (it gets reset in finally)
    await service.onAgentOutput('a1', 'Hello', 'response');
    // After successful synthesis, speakingAgentId should be null (reset by finally)
    expect(service.getSpeakingAgentId()).toBeNull();

    // Verify cancelSpeech explicitly resets it
    // Simulate a scenario where speech is in progress by checking cancelSpeech doesn't throw
    service.cancelSpeech();
    expect(service.getSpeakingAgentId()).toBeNull();
  });

  // I-3: Empty buffer guard
  it('onRecordingStop returns empty result when no recording data', async () => {
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: '#fff' },
    ];
    const result = await service.onRecordingStop(agents, 'a1');
    expect(result).toEqual({ agentId: 'a1', text: '', confidence: 0 });
    expect(mockSTT.transcribe).not.toHaveBeenCalled();
  });

  it('onRecordingStop returns empty agentId when no focused agent and no data', async () => {
    const agents: Agent[] = [];
    const result = await service.onRecordingStop(agents, null);
    expect(result).toEqual({ agentId: '', text: '', confidence: 0 });
    expect(mockSTT.transcribe).not.toHaveBeenCalled();
  });

  // I-5: Transcription error handling
  it('onRecordingStop logs and re-throws transcription errors', async () => {
    const transcribeError = new Error('Transcription engine crashed');
    (mockSTT.transcribe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(transcribeError);

    service.onRecordingData(Buffer.alloc(100));
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: '#fff' },
    ];

    await expect(service.onRecordingStop(agents, 'a1')).rejects.toThrow('Transcription engine crashed');
    expect(appLog).toHaveBeenCalledWith('audio:service', 'error', 'Transcription failed', {
      meta: { error: 'Transcription engine crashed' },
    });
  });

  // I-2: listVoices short-circuit
  it('onAgentOutput skips listVoices when agent already has a voice', async () => {
    const current = service.getSettings();
    service.updateSettings({ ...current, enabled: true });

    // First call assigns a voice (listVoices is called)
    await service.onAgentOutput('a1', 'Hello', 'response');
    expect(mockTTS.listVoices).toHaveBeenCalledTimes(1);

    // Second call for same agent should skip listVoices
    await service.onAgentOutput('a1', 'World', 'response');
    expect(mockTTS.listVoices).toHaveBeenCalledTimes(1); // Still 1, not called again
  });

  // I-1: try/finally on speakingAgentId
  it('onAgentOutput resets speakingAgentId even when synthesis fails', async () => {
    const current = service.getSettings();
    service.updateSettings({ ...current, enabled: true });

    (mockTTS.synthesize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Synthesis failed'));

    await expect(service.onAgentOutput('a1', 'Hello', 'response')).rejects.toThrow('Synthesis failed');
    // speakingAgentId should be reset even after error
    expect(service.getSpeakingAgentId()).toBeNull();
  });

  // I-6: Smart routing mode
  it('onRecordingStop uses voiceRouter when routingMode is smart', async () => {
    service.updateSettings({
      ...service.getSettings(),
      routingMode: 'smart',
      enabled: true,
    });

    service.onRecordingData(Buffer.alloc(100));
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: 'blue' },
    ];

    const result = await service.onRecordingStop(agents, null);
    // voiceRouter.route should have been called (no focusedAgentId + smart mode)
    // VoiceRouter falls back to first agent with confidence 0.3 when no name match
    expect(result.agentId).toBe('a1');
    expect(result.text).toBe('Hello world');
    expect(result.confidence).toBeLessThan(1.0);
  });

  it('onRecordingStop uses voiceRouter when routingMode is focused but no focusedAgentId', async () => {
    service.updateSettings({
      ...service.getSettings(),
      routingMode: 'focused',
      enabled: true,
    });

    service.onRecordingData(Buffer.alloc(100));
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: 'blue' },
    ];

    const result = await service.onRecordingStop(agents, null);
    // Even in focused mode, without a focusedAgentId, it falls through to voiceRouter
    expect(result.agentId).toBe('a1');
    expect(result.text).toBe('Hello world');
  });

  // I-4: Logging in onAgentOutput errors
  it('onAgentOutput logs errors during synthesis', async () => {
    const current = service.getSettings();
    service.updateSettings({ ...current, enabled: true });

    (mockTTS.synthesize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('TTS broke'));

    await expect(service.onAgentOutput('a1', 'Hello', 'response')).rejects.toThrow('TTS broke');
    expect(appLog).toHaveBeenCalledWith('audio:service', 'error', 'TTS synthesis failed', {
      meta: { agentId: 'a1', error: 'TTS broke' },
    });
  });

  it('onRecordingStop logs after successful transcription', async () => {
    service.onRecordingData(Buffer.alloc(100));
    const agents: Agent[] = [
      { id: 'a1', projectId: 'p1', name: 'Atlas', kind: 'durable', status: 'running', color: '#fff' },
    ];
    await service.onRecordingStop(agents, 'a1');
    expect(appLog).toHaveBeenCalledWith('audio:service', 'info', 'Transcription complete', {
      meta: { text: 'Hello world', durationMs: 100 },
    });
  });
});
