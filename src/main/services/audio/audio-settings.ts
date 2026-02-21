import { AudioSettings } from '../../../shared/types';
import { createSettingsStore } from '../settings-store';

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: false,
  sttBackend: 'whisper-local',
  ttsBackend: 'piper-local',
  activationMode: 'push-to-talk',
  vadSensitivity: 0.5,
  ttsFilter: {
    speakResponses: true,
    speakToolSummaries: false,
    speakErrors: true,
    speakStatus: false,
  },
  globalKeybind: 'Space',
  routingMode: 'focused',
};

const store = createSettingsStore<AudioSettings>('audio-settings.json', DEFAULT_AUDIO_SETTINGS);

export const getSettings = store.get;
export const saveSettings = store.save;
