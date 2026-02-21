import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TTSBackendId, VoiceConfig, VoiceInfo } from '../../../../shared/types';
import { appLog } from '../../log-service';
import { TTSEngine } from './tts-engine';

const SYNTHESIS_TIMEOUT_MS = 60_000;

export class PiperBackend implements TTSEngine {
  readonly id: TTSBackendId = 'piper-local';
  readonly displayName = 'Piper (Local)';

  constructor(
    private binaryPath: string,
    private modelsDir: string,
  ) {}

  async initialize(): Promise<void> {
    // No-op — binary is stateless, spawned per invocation
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.binaryPath);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const voices: VoiceInfo[] = [];
    if (!fs.existsSync(this.modelsDir)) return voices;
    const files = fs.readdirSync(this.modelsDir);
    for (const file of files) {
      if (!file.endsWith('.onnx') || file.endsWith('.onnx.json')) continue;
      const voiceId = file.replace('.onnx', '');
      const configPath = path.join(this.modelsDir, `${file}.json`);
      let language = 'en';
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          language = config.language?.code ?? 'en';
        } catch (err) {
          appLog('audio:tts', 'warn', `Failed to parse voice config for ${voiceId}`, {
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      voices.push({
        voiceId,
        voiceName: voiceId.split('-').slice(1, -1).join(' '),
        language,
      });
    }
    return voices;
  }

  async synthesize(text: string, voice: VoiceConfig): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.synthesizeStream(text, voice)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async *synthesizeStream(text: string, voice: VoiceConfig): AsyncIterable<Buffer> {
    const modelPath = path.join(this.modelsDir, `${voice.voiceId}.onnx`);
    const args = ['--model', modelPath, '--output_raw'];
    if (voice.speed && voice.speed !== 1.0) {
      args.push('--length-scale', String(1.0 / voice.speed));
    }

    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const proc = spawn(this.binaryPath, args);

    const outputPromise = new Promise<Buffer[]>((resolve, reject) => {
      const outputChunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk));
      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        appLog('audio:tts', 'error', 'Piper process error', {
          meta: { error: err.message },
        });
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const msg = `Piper exited with code ${code}`;
          appLog('audio:tts', 'error', msg, { meta: { code } });
          reject(new Error(msg));
        } else {
          resolve(outputChunks);
        }
      });

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        appLog('audio:tts', 'warn', 'Piper synthesis timed out', { meta: { binaryPath: this.binaryPath } });
        reject(new Error('Piper synthesis timed out after 60s'));
      }, SYNTHESIS_TIMEOUT_MS);
    });

    proc.stdin.on('error', () => {}); // Errors handled by proc 'error' event
    proc.stdin.write(text);
    proc.stdin.end();

    const chunks = await outputPromise;
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  dispose(): void {
    // No persistent process to clean up
  }
}
