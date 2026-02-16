/**
 * Audio playback utilities for voice chat.
 *
 * Plays S16LE PCM audio from Piper TTS via the Web Audio API.
 * Supports queueing sentences and interruption.
 */

const PIPER_SAMPLE_RATE = 22050;

let playbackContext: AudioContext | null = null;
let playbackQueue: ArrayBuffer[] = [];
let isPlaying = false;
let cancelled = false;

function getContext(): AudioContext {
  if (!playbackContext || playbackContext.state === 'closed') {
    playbackContext = new AudioContext({ sampleRate: PIPER_SAMPLE_RATE });
  }
  return playbackContext;
}

/**
 * Convert S16LE PCM buffer to Float32 samples.
 */
function s16leToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

/**
 * Play a single audio buffer and wait for completion.
 */
function playBuffer(buffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled || buffer.byteLength === 0) {
      resolve();
      return;
    }

    const ctx = getContext();
    const samples = s16leToFloat32(buffer);
    const audioBuffer = ctx.createBuffer(1, samples.length, PIPER_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => resolve();
    source.start();
  });
}

/**
 * Process the playback queue sequentially.
 */
async function processQueue(): Promise<void> {
  if (isPlaying) return;
  isPlaying = true;

  while (playbackQueue.length > 0 && !cancelled) {
    const buffer = playbackQueue.shift()!;
    await playBuffer(buffer);
  }

  isPlaying = false;
}

/**
 * Queue an audio chunk for playback.
 * Chunks are played in order, one at a time.
 */
export function queueAudio(pcmBuffer: ArrayBuffer): void {
  cancelled = false;
  playbackQueue.push(pcmBuffer);
  processQueue();
}

/**
 * Cancel current playback and clear the queue.
 * Called when user starts a new turn (interrupt).
 */
export function cancelPlayback(): void {
  cancelled = true;
  playbackQueue = [];
  isPlaying = false;
}

/**
 * Clean up audio context.
 */
export function cleanup(): void {
  cancelPlayback();
  if (playbackContext && playbackContext.state !== 'closed') {
    playbackContext.close();
    playbackContext = null;
  }
}
