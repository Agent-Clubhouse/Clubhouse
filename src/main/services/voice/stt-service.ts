import { getModelPaths } from './model-manager';

let whisperAddon: any = null;

async function loadWhisper(): Promise<any> {
  if (whisperAddon) return whisperAddon;

  try {
    // Dynamic import to avoid crash if addon not installed
    const addon = require('@anthropic-ai/whisper-node-addon');
    const paths = getModelPaths();
    addon.init(paths.whisper);
    whisperAddon = addon;
    return whisperAddon;
  } catch (err) {
    throw new Error(
      `Failed to load whisper addon: ${err instanceof Error ? err.message : String(err)}. ` +
      'Make sure @anthropic-ai/whisper-node-addon is installed.'
    );
  }
}

/**
 * Transcribe raw PCM audio using Whisper.
 * Input: Float32Array of 16kHz mono PCM samples.
 * Returns: Transcribed text string.
 */
export async function transcribe(pcmBuffer: Float32Array): Promise<string> {
  if (pcmBuffer.length === 0) {
    return '';
  }

  const whisper = await loadWhisper();

  try {
    const result = await whisper.transcribe(pcmBuffer);
    return typeof result === 'string' ? result.trim() : String(result).trim();
  } catch (err) {
    throw new Error(
      `Whisper transcription failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
