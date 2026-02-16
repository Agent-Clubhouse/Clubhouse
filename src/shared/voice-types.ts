export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface VoiceModelInfo {
  name: string;
  path: string;
  size: number;
  ready: boolean;
}

export interface VoiceSessionState {
  agentId: string;
  sessionId?: string;
  transcript: VoiceTranscriptEntry[];
  status: VoiceStatus;
}

export interface VoiceTurnChunk {
  text: string;
  audio?: ArrayBuffer;
  done: boolean;
}

export interface VoiceDownloadProgress {
  model: string;
  percent: number;
  bytesDownloaded: number;
  bytesTotal: number;
}
