import { TTSBackendId, VoiceConfig, VoiceInfo } from '../../../../shared/types';

export interface TTSEngine {
  readonly id: TTSBackendId;
  readonly displayName: string;
  initialize(): Promise<void>;
  isAvailable(): Promise<boolean>;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(text: string, voice: VoiceConfig): Promise<Buffer>;
  synthesizeStream(text: string, voice: VoiceConfig): AsyncIterable<Buffer>;
  dispose(): void;
}
