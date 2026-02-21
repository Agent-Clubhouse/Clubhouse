import { TTSBackendId, VoiceConfig, VoiceInfo } from '../../../../shared/types';
import { appLog } from '../../log-service';
import { TTSEngine } from './tts-engine';

const OPENAI_VOICES: VoiceInfo[] = [
  { voiceId: 'alloy', voiceName: 'Alloy', language: 'en', gender: 'neutral' },
  { voiceId: 'echo', voiceName: 'Echo', language: 'en', gender: 'male' },
  { voiceId: 'fable', voiceName: 'Fable', language: 'en', gender: 'neutral' },
  { voiceId: 'onyx', voiceName: 'Onyx', language: 'en', gender: 'male' },
  { voiceId: 'nova', voiceName: 'Nova', language: 'en', gender: 'female' },
  { voiceId: 'shimmer', voiceName: 'Shimmer', language: 'en', gender: 'female' },
];

export class CloudTTSBackend implements TTSEngine {
  readonly id: TTSBackendId = 'openai-cloud';
  readonly displayName = 'OpenAI TTS (Cloud)';

  async initialize(): Promise<void> {}

  async isAvailable(): Promise<boolean> {
    return !!process.env.OPENAI_API_KEY;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return OPENAI_VOICES;
  }

  async synthesize(text: string, voice: VoiceConfig): Promise<Buffer> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: voice.voiceId,
        speed: voice.speed ?? 1.0,
        response_format: 'pcm',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      appLog('audio:tts', 'error', 'Cloud TTS request failed', { meta: { status: response.status, error: errText } });
      throw new Error(`Cloud TTS failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *synthesizeStream(text: string, voice: VoiceConfig): AsyncIterable<Buffer> {
    // For simplicity, use non-streaming synthesis and yield the full buffer
    const audio = await this.synthesize(text, voice);
    yield audio;
  }

  dispose(): void {}
}
