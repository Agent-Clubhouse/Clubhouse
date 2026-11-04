/** PILOT, never ships. The real dialog and real CSS with a fake `window.clubhouse`, for scripts/pilot/run-chromium.mjs. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';

const feedback: Record<string, unknown> = {
  getStatus: async (): Promise<unknown> => ({ started: true, state: 'connected', connected: true, enrolled: true, canCapture: true, notice: null as null, expiresAt: null as null, storage: { available: true }, outbox: { state: 'available', pending: 0, blocked: 0, heldForEnrollment: 0, heldBytes: 0, releaseToken: null as null, bytes: 0, maxItems: 10, maxBytes: 33554432 }, received: [] as string[] }),
  onStatusChanged: (): (() => void) => () => undefined,
  onCaptured: (): (() => void) => () => undefined,
  cancel: async (): Promise<void> => undefined,
  send: async (): Promise<never> => { throw new Error('the harness replaces send'); },
};
(window as unknown as { clubhouse: unknown }).clubhouse = { feedback };

void import('./FeedbackDialogHost').then(({ FeedbackDialogHost }) => {
  const host = <FeedbackDialogHost />;
  createRoot(document.getElementById('root')!).render(location.search.includes('strict') ? <StrictMode>{host}</StrictMode> : host);
});
