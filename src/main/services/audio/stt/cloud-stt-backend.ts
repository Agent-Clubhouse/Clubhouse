import { STTBackendId, STTOpts, STTResult } from '../../../../shared/types';
import { appLog } from '../../log-service';
import { STTEngine } from './stt-engine';

export class CloudSTTBackend implements STTEngine {
  readonly id: STTBackendId = 'openai-cloud';
  readonly displayName = 'OpenAI Whisper (Cloud)';

  async initialize(): Promise<void> {}

  async isAvailable(): Promise<boolean> {
    return !!process.env.OPENAI_API_KEY;
  }

  async transcribe(audio: Buffer, opts?: STTOpts): Promise<STTResult> {
    const startMs = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const formData = new FormData();
    formData.append('file', new Blob([audio as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-1');
    if (opts?.language) formData.append('language', opts.language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      appLog('audio:stt', 'error', 'Cloud STT request failed', { meta: { status: response.status, error: errText } });
      throw new Error(`Cloud STT failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      text: data.text?.trim() ?? '',
      durationMs: Date.now() - startMs,
    };
  }

  dispose(): void {}
}
