import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { NotificationSettings } from '../../shared/types';
import * as notificationService from '../services/notification-service';

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.APP.GET_NOTIFICATION_SETTINGS, () => {
    return notificationService.getSettings();
  });

  ipcMain.handle(IPC.APP.SAVE_NOTIFICATION_SETTINGS, (_event, settings: NotificationSettings) => {
    notificationService.saveSettings(settings);
  });

  ipcMain.handle(IPC.APP.SEND_NOTIFICATION, (_event, title: string, body: string, silent: boolean) => {
    notificationService.sendNotification(title, body, silent);
  });
}
