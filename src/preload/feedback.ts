import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { FeedbackCaptureResult, FeedbackSendInput, FeedbackSendResult, FeedbackStatus } from '../shared/feedback-types';

/** Framebriar screenshot feedback. Tokens and the invitation never come back over this bridge. */
export const feedback = {
  feedback: {
    getStatus: (): Promise<FeedbackStatus> =>
      ipcRenderer.invoke(IPC.FEEDBACK.GET_STATUS),
    connect: (invitation: string): Promise<{ connected: boolean; status: FeedbackStatus }> =>
      ipcRenderer.invoke(IPC.FEEDBACK.CONNECT, invitation),
    disconnect: (): Promise<{ forgotten: boolean; revoked: boolean | null; status: FeedbackStatus }> =>
      ipcRenderer.invoke(IPC.FEEDBACK.DISCONNECT),
    /** Screenshot this window, then the other Clubhouse windows; returns a draft for the review dialog. */
    capture: (): Promise<FeedbackCaptureResult> =>
      ipcRenderer.invoke(IPC.FEEDBACK.CAPTURE),
    send: (input: FeedbackSendInput): Promise<FeedbackSendResult> =>
      ipcRenderer.invoke(IPC.FEEDBACK.SEND, input),
    cancel: (draftId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.FEEDBACK.CANCEL, draftId),
    /** A draft captured with the keyboard shortcut (#2101), to open in the review dialog. */
    onCaptured: (callback: (draft: FeedbackCaptureResult) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, draft: FeedbackCaptureResult) => callback(draft);
      ipcRenderer.on(IPC.FEEDBACK.CAPTURED, listener);
      return () => { ipcRenderer.removeListener(IPC.FEEDBACK.CAPTURED, listener); };
    },
    /** null when Feedback stopped (its switch was turned off). */
    onStatusChanged: (callback: (status: FeedbackStatus | null) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: FeedbackStatus | null) => callback(status);
      ipcRenderer.on(IPC.FEEDBACK.STATUS_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.FEEDBACK.STATUS_CHANGED, listener); };
    },
  },
};
