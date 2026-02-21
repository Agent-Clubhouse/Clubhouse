import { STTBackendId, STTOpts, STTResult } from '../../../../shared/types';

export interface STTEngine {
  readonly id: STTBackendId;
  readonly displayName: string;
  initialize(): Promise<void>;
  isAvailable(): Promise<boolean>;
  transcribe(audio: Buffer, opts?: STTOpts): Promise<STTResult>;
  dispose(): void;
}
