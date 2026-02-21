import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STTBackendId, STTOpts, STTResult } from '../../../../shared/types';
import { appLog } from '../../log-service';
import { STTEngine } from './stt-engine';

/** Write a PCM Int16 buffer as a WAV file (16kHz mono 16-bit). */
function writeWav(filePath: string, pcm: Buffer, sampleRate = 16000): void {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

const TRANSCRIPTION_TIMEOUT_MS = 30_000;

export class WhisperBackend implements STTEngine {
  readonly id: STTBackendId = 'whisper-local';
  readonly displayName = 'Whisper (Local)';

  constructor(
    private binaryPath: string,
    private modelPath: string,
  ) {}

  async initialize(): Promise<void> {
    // No-op — binary is stateless, spawned per invocation
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.binaryPath) && fs.existsSync(this.modelPath);
  }

  async transcribe(audio: Buffer, opts?: STTOpts): Promise<STTResult> {
    const startMs = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    const wavPath = path.join(tmpDir, 'input.wav');

    try {
      writeWav(wavPath, audio, opts?.sampleRate ?? 16000);

      const args = [
        '-m', this.modelPath,
        '-f', wavPath,
        '--no-timestamps',
        '-l', opts?.language ?? 'en',
      ];

      const stdout = await new Promise<string>((resolve, reject) => {
        let settled = false;
        // eslint-disable-next-line prefer-const -- must be `let` to avoid TDZ error when callback fires synchronously
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const proc = execFile(this.binaryPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          if (err) {
            appLog('audio:stt', 'error', 'Whisper transcription failed', { meta: { error: err.message } });
            reject(err);
          } else {
            resolve(stdout);
          }
        });

        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill();
          appLog('audio:stt', 'warn', 'Whisper transcription timed out', { meta: { binaryPath: this.binaryPath } });
          reject(new Error('Whisper transcription timed out after 30s'));
        }, TRANSCRIPTION_TIMEOUT_MS);
      });

      const text = stdout.trim();
      return {
        text,
        durationMs: Date.now() - startMs,
      };
    } finally {
      try { fs.unlinkSync(wavPath); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  }

  dispose(): void {
    // No persistent process to clean up
  }
}
