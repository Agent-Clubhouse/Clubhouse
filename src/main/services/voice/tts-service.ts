import { spawn, ChildProcess } from 'child_process';
import { getModelPaths } from './model-manager';

let piperProcess: ChildProcess | null = null;
let piperReady = false;

function ensurePiper(): void {
  if (piperProcess && !piperProcess.killed) return;

  const paths = getModelPaths();

  piperProcess = spawn(paths.piperBinary, [
    '--model', paths.piperVoice,
    '--output-raw',
    '--json-input',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  piperProcess.on('error', (err) => {
    console.error('Piper process error:', err);
    piperProcess = null;
    piperReady = false;
  });

  piperProcess.on('exit', () => {
    piperProcess = null;
    piperReady = false;
  });

  piperReady = true;
}

/**
 * Map an agent ID to a consistent speaker index (0-108 range for VCTK model).
 */
export function agentSpeakerId(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 109;
}

/**
 * Synthesize text to raw S16LE PCM audio using Piper.
 * Returns a Buffer of signed 16-bit little-endian PCM at 22050Hz.
 */
export async function synthesize(text: string, speakerId?: number): Promise<Buffer> {
  if (!text.trim()) {
    return Buffer.alloc(0);
  }

  ensurePiper();

  if (!piperProcess || !piperProcess.stdin || !piperProcess.stdout) {
    throw new Error('Piper process not available');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    const jsonInput = JSON.stringify({
      text: text.trim(),
      speaker_id: speakerId ?? 0,
    });

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      totalSize += chunk.length;
    };

    // Piper outputs raw PCM for each input line, terminated when next input arrives
    // We use a timeout to detect end of output for a given input
    let timer: ReturnType<typeof setTimeout>;

    const finish = () => {
      piperProcess?.stdout?.removeListener('data', onData);
      resolve(Buffer.concat(chunks, totalSize));
    };

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, 200); // 200ms silence = done
    };

    const onDataWithTimer = (chunk: Buffer) => {
      onData(chunk);
      resetTimer();
    };

    piperProcess.stdout.on('data', onDataWithTimer);

    // Write JSON input line
    piperProcess.stdin.write(jsonInput + '\n', (err) => {
      if (err) {
        piperProcess?.stdout?.removeListener('data', onDataWithTimer);
        reject(err);
      }
    });

    // Start the timer for initial response
    resetTimer();

    // Safety timeout: 10 seconds max
    const safetyTimer = setTimeout(() => {
      piperProcess?.stdout?.removeListener('data', onDataWithTimer);
      clearTimeout(timer);
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks, totalSize));
      } else {
        reject(new Error('Piper TTS timed out'));
      }
    }, 10000);

    // Clean up safety timer when done
    const originalFinish = finish;
    const finishWithCleanup = () => {
      clearTimeout(safetyTimer);
      originalFinish();
    };
    // Override the timer callback
    timer = setTimeout(finishWithCleanup, 200);
  });
}

/**
 * Kill the Piper subprocess. Call on app quit.
 */
export function cleanup(): void {
  if (piperProcess && !piperProcess.killed) {
    piperProcess.kill();
    piperProcess = null;
    piperReady = false;
  }
}
