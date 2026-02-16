/**
 * Mic capture utilities for voice chat.
 *
 * Captures raw PCM audio from the user's microphone,
 * downsampled to 16kHz mono Float32Array for Whisper.
 */

const TARGET_SAMPLE_RATE = 16000;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let capturedChunks: Float32Array[] = [];

/**
 * Request microphone access and start capturing PCM audio.
 */
export async function startCapture(): Promise<void> {
  capturedChunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: { ideal: TARGET_SAMPLE_RATE },
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Use ScriptProcessorNode for broad compatibility
  // (AudioWorklet preferred in production but requires separate file)
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

  processor.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    capturedChunks.push(new Float32Array(inputData));
  };

  sourceNode.connect(processor);
  processor.connect(audioContext.destination);
  workletNode = processor;
}

/**
 * Stop capturing and return the accumulated PCM buffer.
 * Returns Float32Array of 16kHz mono PCM samples.
 */
export function stopCapture(): Float32Array {
  // Disconnect and cleanup
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  // Merge all chunks into a single Float32Array
  const totalLength = capturedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of capturedChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  capturedChunks = [];
  return merged;
}

/**
 * Check if microphone permission is available.
 */
export async function checkMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}
