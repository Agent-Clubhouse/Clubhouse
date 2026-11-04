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
  if (code === 'storage-unavailable') return 'Couldn\'t read saved feedback on this computer. Nothing was queued.';
  if (code === 'stale-release') return 'The held reports changed. Nothing was queued.';
  const parts = [`${reports(released)} queued to send.`];
  if (remaining > 0) parts.push(`${remaining} still held.`);
  if (failed > 0) parts.push(`${failed} failed.`);
  return parts.join(' ');
}

export function clearResultText({ cleared, remaining, failed, code }: Omit<FeedbackHeldClearResult, 'status'>): string {
  if (code) return 'Couldn\'t read saved feedback on this computer. Nothing was cleared.';
  const parts = [`${reports(cleared)} cleared.`];
  if (remaining > 0) parts.push(`${remaining} still held.`);
  if (failed > 0) parts.push(`${failed} failed.`);
  return parts.join(' ');
}

/** The confirmation holds what the user is shown, including the token, whatever status does next. */
type Ask =
  | { kind: 'send'; releaseToken: string; held: number; bytes: number; changed: boolean }
  | { kind: 'clear'; held: number; bytes: number };

/**
 * Reports saved under an earlier feedback connection never go out with a new one on their own:
 * the user sends or clears them here. The enrollment behind them is opaque, so nothing here can
 * name an account.
 */
export function FeedbackHeldReports({ status, onStatus }: { status: FeedbackStatus; onStatus: (status: FeedbackStatus) => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { heldForEnrollment: held, heldBytes: bytes, releaseToken } = status.outbox;

  const send = async (releaseToken: string) => {
    setBusy(true);
    try {
      const { status: next, ...result } = await window.clubhouse.feedback.releaseHeld(releaseToken);
      onStatus(next);
      const fresh = next.outbox.releaseToken;
      if (result.code === 'stale-release' && fresh) {
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

  const clear = async () => {
    setBusy(true);
    try {
      const { status: next, ...result } = await window.clubhouse.feedback.clearHeld();
      onStatus(next);
      setMessage(clearResultText(result));
    } catch (err) {
      // telemetry-exempt: shown to the user
      setMessage(`Couldn't clear the held reports. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAsk(null);
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
            help={releaseToken
              ? 'Saved under an earlier feedback connection. They stay on this computer until you send or clear them.'
              : 'Saved under an earlier feedback connection. Send isn\'t available without a working connection. You can clear them now, or connect and send them.'}
          >
            <Button
              onClick={() => { setMessage(null); if (releaseToken) setAsk({ kind: 'send', releaseToken, held, bytes, changed: false }); }}
              disabled={busy || !releaseToken}
              kind="ghost"
            >
              Send
            </Button>
            <Button onClick={() => { setMessage(null); setAsk({ kind: 'clear', held, bytes }); }} disabled={busy} kind="ghost">
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
            <p>{reports(ask.held)}{sizeText(ask.bytes)} saved under an earlier feedback connection will be queued to send with the current one, exactly as you reviewed them.</p>
          </div>
        </Modal>
      )}
      {ask?.kind === 'clear' && (
        <Modal open onClose={() => { if (!busy) setAsk(null); }} title="Clear held reports?" width="w-[440px]" footer={
          <>
            <Button onClick={() => setAsk(null)} disabled={busy} kind="ghost">Cancel</Button>
            <Button onClick={() => void clear()} disabled={busy} kind="primary">Clear</Button>
          </>
        }>
          <p className="text-[13px] text-ctp-subtext1" data-testid="feedback-held-confirm">
            {reports(ask.held)}{sizeText(ask.bytes)} will be deleted from this computer. They can&apos;t be sent after this.
          </p>
        </Modal>
      )}
    </div>
  );
}
