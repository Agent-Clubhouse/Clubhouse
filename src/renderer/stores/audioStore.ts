import { create } from 'zustand';
import { AudioSettings, VoiceConfig, VoiceInfo } from '../../shared/types';

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

interface AudioState {
  settings: AudioSettings | null;
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  speakingAgentId: string | null;
  availableVoices: VoiceInfo[];
  /** Populated by VoiceSelector (Task 13) for per-agent voice overrides. */
  agentVoiceAssignments: Record<string, VoiceConfig>;
  micPermission: MicPermissionState;

  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<AudioSettings>) => Promise<void>;
  setRecording: (recording: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
  setSpeaking: (speaking: boolean, agentId?: string) => void;
  loadVoices: () => Promise<void>;
  checkMicPermission: () => Promise<void>;
}

export const useAudioStore = create<AudioState>((set, get) => ({
  settings: null,
  recording: false,
  transcribing: false,
  speaking: false,
  speakingAgentId: null,
  availableVoices: [],
  agentVoiceAssignments: {},
  micPermission: 'unknown',

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.audio.getSettings();
      set({ settings });
    } catch {
      // IPC failure; keep current state
    }
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    if (!current) return;
    const merged = { ...current, ...partial };
    set({ settings: merged });
    try {
      await window.clubhouse.audio.saveSettings(merged);
    } catch {
      set({ settings: current }); // rollback on failure
    }
  },

  setRecording: (recording) => set({ recording }),
  setTranscribing: (transcribing) => set({ transcribing }),

  setSpeaking: (speaking, agentId) =>
    set({ speaking, speakingAgentId: speaking ? (agentId ?? null) : null }),

  loadVoices: async () => {
    try {
      const voices = await window.clubhouse.audio.getVoices();
      set({ availableVoices: voices });
    } catch {
      // IPC failure; keep current voices list
    }
  },

  checkMicPermission: async () => {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      set({ micPermission: status.state as MicPermissionState });
      status.onchange = () => {
        set({ micPermission: status.state as MicPermissionState });
      };
    } catch {
      // permissions.query not supported; fall back to unknown
      set({ micPermission: 'unknown' });
    }
  },
}));
