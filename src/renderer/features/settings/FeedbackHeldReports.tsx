import { useState } from 'react';
import type { FeedbackHeldClearResult, FeedbackHeldReleaseResult, FeedbackStatus } from '../../../shared/feedback-types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { SettingsField, SettingsSection, settingsHelp } from './SettingsLayout';

const reports = (n: number) => `${n} ${n === 1 ? 'report' : 'reports'}`;

function sizeText(bytes: number): string {
  if (bytes <= 0) return '';
  return bytes < 1024 * 1024 ? ` (${Math.ceil(bytes / 1024)} KB)` : ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
}

/** What a release did. Queued, because delivery comes later and may not happen at all. */
export function releaseResultText({ released, remaining, failed, code }: Omit<FeedbackHeldReleaseResult, 'status'>): string {
  if (code === 'not-enrolled') return 'Connect to Feedback to send held reports. Nothing was queued.';
  if (code === 'storage-unavailable') return 'Couldn\'t read saved feedback on this computer. Nothing was queued. Try Send again. If it keeps happening, restart Clubhouse.';
  if (code === 'stale-release') return 'The held reports changed. Nothing was queued.';
  const parts = [`${reports(released)} queued to send.`];
  if (remaining > 0) parts.push(`${remaining} still held.`);
  if (failed > 0) parts.push('Try Send again.');
  return parts.join(' ');
}

export function clearResultText({ cleared, remaining, failed, code }: Omit<FeedbackHeldClearResult, 'status'>): string {
  if (code === 'stale-release') return 'The held reports changed. Nothing was cleared.';
  if (code) return 'Couldn\'t read saved feedback on this computer. Nothing was cleared. Try Clear again. If it keeps happening, restart Clubhouse.';
  const parts = [`${reports(cleared)} cleared.`];
  if (remaining > 0) parts.push(`${remaining} still held.`);
  if (failed > 0) parts.push('Try Clear again.');
  return parts.join(' ');
}

/** The confirmation holds what the user is shown, including the token, whatever status does next. */
type Ask =
  | { kind: 'send'; releaseToken: string; held: number; bytes: number; changed: boolean }
  | { kind: 'clear'; clearToken: string; held: number; bytes: number; changed: boolean };

/**
 * Reports saved under an earlier feedback connection never go out with a new one on their own:
 * the user sends or clears them here. The enrollment behind them is opaque, so nothing here can
 * name an account. The SDK also holds a report whose saved state it can't read, and doesn't say
 * which is which, so the words don't promise an earlier connection.
 */
export function FeedbackHeldReports({ status, onStatus }: { status: FeedbackStatus; onStatus: (status: FeedbackStatus) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { heldForEnrollment: held, heldBytes: bytes, releaseToken, clearToken } = status.outbox;

  const send = async (releaseToken: string) => {
    setBusy(true);
    try {
      const { status: next, ...result } = await window.clubhouse.feedback.releaseHeld(releaseToken);
      onStatus(next);
      const fresh = next.outbox.releaseToken;
      // The same token means status hasn't caught up yet: the SDK returns without it after 1 s.
      if (result.code === 'stale-release' && fresh && fresh !== releaseToken) {
        // Ask again with what's true now. Nothing moved, and only a new confirmation can move it.
        setAsk({ kind: 'send', releaseToken: fresh, held: next.outbox.heldForEnrollment, bytes: next.outbox.heldBytes, changed: true });
        return;
      }
      setAsk(null);
      setMessage(releaseResultText(result));
    } catch (err) {
      // telemetry-exempt: shown to the user
      setAsk(null);
      setMessage(`Couldn't queue the held reports. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (clearToken: string) => {
    setBusy(true);
    try {
      const { status: next, ...result } = await window.clubhouse.feedback.clearHeld(clearToken);
      onStatus(next);
      const fresh = next.outbox.clearToken;
      if (result.code === 'stale-release' && fresh && fresh !== clearToken) {
        // Ask again with what's true now. Nothing was deleted, and only a new confirmation can delete it.
        setAsk({ kind: 'clear', clearToken: fresh, held: next.outbox.heldForEnrollment, bytes: next.outbox.heldBytes, changed: true });
        return;
      }
      setAsk(null);
      setMessage(clearResultText(result));
    } catch (err) {
      // telemetry-exempt: shown to the user
      setAsk(null);
      setMessage(`Couldn't clear the held reports. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (held === 0 && !message && !ask) return null;

  return (
    <div data-testid="feedback-held">
      {held > 0 && (
        <SettingsSection title="Held reports">
          <SettingsField
            label={`${reports(held)} held${sizeText(bytes)}`}
            help={!clearToken
              ? 'Couldn\'t read saved feedback on this computer, so these can\'t be sent or cleared right now. They stay on this computer.'
              : releaseToken
                ? 'These reports are waiting for your choice. They may be from an earlier feedback connection, or their saved state can\'t be read right now. They stay on this computer until you send or clear them.'
                : 'These reports are waiting for your choice. They may be from an earlier feedback connection, or their saved state can\'t be read right now. Send isn\'t available without a working connection. You can clear them now, or connect and send them.'}
          >
            <Button
              onClick={() => { setMessage(null); if (releaseToken) setAsk({ kind: 'send', releaseToken, held, bytes, changed: false }); }}
              disabled={busy || !releaseToken}
              kind="ghost"
            >
              Send
            </Button>
            <Button
              onClick={() => { setMessage(null); if (clearToken) setAsk({ kind: 'clear', clearToken, held, bytes, changed: false }); }}
              disabled={busy || !clearToken}
              kind="ghost"
            >
              Clear
            </Button>
          </SettingsField>
        </SettingsSection>
      )}
      {message && <p className={`${settingsHelp} mt-2`} role="status" data-testid="feedback-held-message">{message}</p>}
      {ask?.kind === 'send' && (
        <Modal open onClose={() => { if (!busy) setAsk(null); }} title="Send held reports?" width="w-[440px]" footer={
          <>
            <Button onClick={() => setAsk(null)} disabled={busy} kind="ghost">Cancel</Button>
            <Button onClick={() => void send(ask.releaseToken)} disabled={busy} kind="primary">Send</Button>
          </>
        }>
          <div className="space-y-3 text-[13px] text-ctp-subtext1" data-testid="feedback-held-confirm">
            {ask.changed && <p className="text-ctp-text">The held reports changed. Check the count and confirm again.</p>}
            <p>{reports(ask.held)}{sizeText(ask.bytes)} held on this computer will be queued to send with the current feedback connection, exactly as you reviewed them.</p>
          </div>
        </Modal>
      )}
      {ask?.kind === 'clear' && (
        <Modal open onClose={() => { if (!busy) setAsk(null); }} title="Clear held reports?" width="w-[440px]" footer={
          <>
            <Button onClick={() => setAsk(null)} disabled={busy} kind="ghost">Cancel</Button>
            <Button onClick={() => void clear(ask.clearToken)} disabled={busy} kind="primary">Clear</Button>
          </>
        }>
          <div className="space-y-3 text-[13px] text-ctp-subtext1" data-testid="feedback-held-confirm">
            {ask.changed && <p className="text-ctp-text">The held reports changed. Check the count and confirm again.</p>}
            <p>{reports(ask.held)}{sizeText(ask.bytes)} will be deleted from this computer. They can&apos;t be sent after this.</p>
            <p>{releaseToken
              ? 'A held report may be one that could still be sent. To queue them to send instead, choose Cancel, then Send.'
              : 'A held report may be one that could still be sent. Send isn\'t available without a working connection, so choose Cancel to keep them.'}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
