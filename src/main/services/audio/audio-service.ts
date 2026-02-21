import { AudioSettings, OutputKind, STTBackendId, TTSBackendId, Agent } from '../../../shared/types';
import { getSettings, saveSettings } from './audio-settings';
import { STTEngine } from './stt/stt-engine';
import { TTSEngine } from './tts/tts-engine';
import { VoiceManager } from './voice-manager';
import { VoiceRouter, RouteResult } from './voice-router';
import { shouldSpeak } from './tts-filter';
import { appLog } from '../log-service';

export class AudioService {
  private sttEngines = new Map<STTBackendId, STTEngine>();
  private ttsEngines = new Map<TTSBackendId, TTSEngine>();
  private voiceManager = new VoiceManager();
  private voiceRouter = new VoiceRouter();
  private settings: AudioSettings;
  private recordingBuffer: Buffer[] = [];
  private speakingAgentId: string | null = null;

  constructor() {
    this.settings = getSettings();
  }

  async initialize(): Promise<void> {
    appLog('audio:service', 'info', 'AudioService initializing');
    this.settings = getSettings();
    for (const engine of this.sttEngines.values()) {
      await engine.initialize();
    }
    for (const engine of this.ttsEngines.values()) {
      await engine.initialize();
    }
  }

  getSettings(): AudioSettings {
    return this.settings;
  }

  updateSettings(settings: AudioSettings): void {
    this.settings = settings;
    saveSettings(settings);
  }

  registerSTTEngine(engine: STTEngine): void {
    this.sttEngines.set(engine.id, engine);
  }

  registerTTSEngine(engine: TTSEngine): void {
    this.ttsEngines.set(engine.id, engine);
  }

  getActiveSTTEngine(): STTEngine {
    const engine = this.sttEngines.get(this.settings.sttBackend);
    if (!engine) {
      const first = this.sttEngines.values().next().value;
      if (!first) throw new Error('No STT engine registered');
      return first;
    }
    return engine;
  }

  getActiveTTSEngine(): TTSEngine {
    const engine = this.ttsEngines.get(this.settings.ttsBackend);
    if (!engine) {
      const first = this.ttsEngines.values().next().value;
      if (!first) throw new Error('No TTS engine registered');
      return first;
    }
    return engine;
  }

  onRecordingData(chunk: Buffer): void {
    this.recordingBuffer.push(chunk);
  }

  async onRecordingStop(agents: Agent[], focusedAgentId: string | null): Promise<RouteResult> {
    if (this.recordingBuffer.length === 0) {
      return { agentId: focusedAgentId ?? '', text: '', confidence: 0 };
    }

    const audio = Buffer.concat(this.recordingBuffer);
    this.recordingBuffer = [];

    const stt = this.getActiveSTTEngine();
    let result;
    try {
      result = await stt.transcribe(audio);
    } catch (err) {
      appLog('audio:service', 'error', 'Transcription failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }

    appLog('audio:service', 'info', 'Transcription complete', {
      meta: { text: result.text, durationMs: result.durationMs },
    });

    if (this.settings.routingMode === 'focused' && focusedAgentId) {
      return { agentId: focusedAgentId, text: result.text, confidence: 1.0 };
    }

    return this.voiceRouter.route(result.text, agents, focusedAgentId);
  }

  async onAgentOutput(agentId: string, text: string, kind: OutputKind): Promise<Buffer | null> {
    if (!this.settings.enabled) return null;
    if (!shouldSpeak(text, kind, this.settings.ttsFilter)) return null;

    const tts = this.getActiveTTSEngine();
    let voice = this.voiceManager.getVoiceForAgent(agentId);
    if (!voice) {
      const voices = await tts.listVoices();
      voice = this.voiceManager.assignVoice(agentId, voices);
    }

    this.speakingAgentId = agentId;
    try {
      const audio = await tts.synthesize(text, voice);
      return audio;
    } catch (err) {
      appLog('audio:service', 'error', 'TTS synthesis failed', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    } finally {
      this.speakingAgentId = null;
    }
  }

  cancelSpeech(): void {
    this.speakingAgentId = null;
  }

  getSpeakingAgentId(): string | null {
    return this.speakingAgentId;
  }

  getVoiceManager(): VoiceManager {
    return this.voiceManager;
  }

  getVoiceRouter(): VoiceRouter {
    return this.voiceRouter;
  }

  dispose(): void {
    for (const engine of this.sttEngines.values()) engine.dispose();
    for (const engine of this.ttsEngines.values()) engine.dispose();
    appLog('audio:service', 'info', 'AudioService disposed');
  }
}
