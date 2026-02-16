import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as modelManager from '../services/voice/model-manager';
import * as sttService from '../services/voice/stt-service';
import * as voiceSession from '../services/voice/voice-session';
import { appLog } from '../services/log-service';

export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.VOICE.CHECK_MODELS, () => {
    return modelManager.checkModels();
  });

  ipcMain.handle(IPC.VOICE.DOWNLOAD_MODELS, async () => {
    appLog('voice:model-manager', 'info', 'Starting model download');
    try {
      await modelManager.downloadModels();
    } catch (err) {
      appLog('voice:model-manager', 'error', 'Model download failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });

  ipcMain.handle(IPC.VOICE.DELETE_MODELS, () => {
    modelManager.deleteModels();
  });

  ipcMain.handle(IPC.VOICE.TRANSCRIBE, async (_event, pcmData: ArrayBuffer) => {
    const pcmFloat32 = new Float32Array(pcmData);
    return sttService.transcribe(pcmFloat32);
  });

  ipcMain.handle(IPC.VOICE.START_SESSION, (_event, agentId: string, cwd: string, model?: string) => {
    return voiceSession.startSession(cwd, agentId, model);
  });

  ipcMain.handle(IPC.VOICE.SEND_TURN, async (_event, text: string) => {
    await voiceSession.sendTurn(text);
  });

  ipcMain.handle(IPC.VOICE.END_SESSION, () => {
    voiceSession.endSession();
  });
}
