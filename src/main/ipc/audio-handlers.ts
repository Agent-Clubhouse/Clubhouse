import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { AudioSettings, Agent, OutputKind } from '../../shared/types';
import { AudioService } from '../services/audio/audio-service';
import { appLog } from '../services/log-service';

let audioService: AudioService | null = null;

export function getAudioService(): AudioService {
  if (!audioService) {
    audioService = new AudioService();
  }
  return audioService;
}

export function registerAudioHandlers(): void {
  const service = getAudioService();

  ipcMain.handle(IPC.AUDIO.GET_SETTINGS, () => {
    return service.getSettings();
  });

  ipcMain.handle(IPC.AUDIO.SAVE_SETTINGS, (_event, settings: AudioSettings) => {
    service.updateSettings(settings);
  });

  ipcMain.handle(IPC.AUDIO.START_RECORDING, () => {
    // Recording buffer is managed via RECORDING_DATA stream; no main-process action needed.
  });

  ipcMain.on(IPC.AUDIO.RECORDING_DATA, (_event, chunk: Buffer) => {
    service.onRecordingData(chunk);
  });

  ipcMain.handle(IPC.AUDIO.STOP_RECORDING, async (_event, agents: Agent[], focusedAgentId: string | null) => {
    return service.onRecordingStop(agents, focusedAgentId);
  });

  ipcMain.handle(IPC.AUDIO.SPEAK, async (_event, agentId: string, text: string, kind: string) => {
    try {
      const audio = await service.onAgentOutput(agentId, text, kind as OutputKind);
      if (audio) {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send(IPC.AUDIO.SPEAK_AUDIO, audio);
        }
      }
    } catch (err) {
      appLog('audio:ipc', 'error', 'Speak failed', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });

  ipcMain.on(IPC.AUDIO.CANCEL_SPEECH, () => {
    service.cancelSpeech();
  });

  ipcMain.handle(IPC.AUDIO.GET_VOICES, async () => {
    try {
      const tts = service.getActiveTTSEngine();
      return tts.listVoices();
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.AUDIO.GET_MODELS, async () => {
    // Stub: model management will be implemented in a future task.
    return [];
  });

  ipcMain.handle(IPC.AUDIO.DOWNLOAD_MODEL, async () => {
    // Stub: model download will be implemented in a future task.
  });

  ipcMain.handle(IPC.AUDIO.ROUTE_SPEECH, async () => {
    // Stub: speech routing will be implemented in a future task.
    return null;
  });
}
