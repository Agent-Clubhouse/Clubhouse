import { useEffect, useRef, useState } from 'react';
import type { FeedbackStatus } from '../../../shared/feedback-types';
import { FEEDBACK_NOTICE_TEXT, useFeedbackStore } from '../../stores/feedbackStore';
import { FeedbackTelemetryPrompt, type TelemetryShareAsk } from './FeedbackTelemetryPrompt';
import { SettingsPage, SettingsSection, SettingsField, settingsButton, settingsInput, settingsHelp } from './SettingsLayout';

/**
 * After connecting, offer the Framebriar telemetry destination when export is already on
 * somewhere else: it asks the main process, which requires confirming Framebriar's host.
 * Returns what to confirm, or null when there's nothing to ask.
 */
async function framebriarTelemetryAsk(): Promise<TelemetryShareAsk | null> {
  const api = window.clubhouse.telemetrySettings;
  const status = await api.getStatus();
  if (!status?.available || !status.consentAccepted) return null;
  const fb = status.destinations.find((d) => d.id === 'framebriar');
  // Already on, or the user said "Not now" before: don't ask again.
  if (!fb || fb.enabled || fb.userOff) return null;
  if (!status.destinations.some((d) => d.id !== 'framebriar' && d.enabled)) return null;
  const result = await api.setEnabled('framebriar', true, {});
  if ('needs' in result && result.host) return { host: result.host, hosts: result.hosts ?? [result.host] };
  return null;
}

/** What the platform calls the keyring that safeStorage needs. */
function keyringName(): string {
  const p = window.clubhouse.platform;
  if (p === 'darwin') return 'macOS Keychain';
  if (p === 'win32') return 'Windows credential store';
  return 'system keyring (GNOME Keyring or KWallet)';
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
}

/** Why the invitation we just sent didn't connect, as far as the notice tells. */
export function connectFailedMessage(notice: FeedbackStatus['notice']): string {
  if (notice === 'connection-uncertain') {
    return 'Couldn\'t confirm the connection. The feedback server can be slow to wake up and may still have accepted the invitation, so try the same one again.';
  }
  if (notice === 'access-required') return 'That invitation wasn\'t accepted. It may have expired, been revoked or been used up.';
  return 'Couldn\'t connect with that invitation.';
}

const STATE_TEXT: Record<string, string> = {
  checking: 'Checking…',
  connecting: 'Connecting…',
  disconnecting: 'Disconnecting…',
  offline: 'Offline. Feedback is saved and sent when Clubhouse is back online.',
  stopped: 'Paused.',
};

/**
 * Settings › Feedback: connect with an invitation (the only thing needed: no URL or key),
 * see the connection and its expiry, disconnect.
 */
export function FeedbackSettingsView() {
  const status = useFeedbackStore((s) => s.status);
  const loaded = useFeedbackStore((s) => s.loaded);
  const init = useFeedbackStore((s) => s.init);
  const setStatus = useFeedbackStore((s) => s.setStatus);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shareAsk, setShareAsk] = useState<TelemetryShareAsk | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void init(); }, [init]);

  if (!status) {
    return (
      <SettingsPage
        title="Feedback"
        description={loaded ? 'Feedback isn\'t available right now.' : 'Loading…'}
        testId="feedback-settings"
      >
        {null}
      </SettingsPage>
    );
  }

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = inputRef.current;
    const invitation = input?.value.trim() ?? '';
    // Clear the field at once: the invitation is single-use and never kept in the UI.
    if (input) input.value = '';
    if (!invitation) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.clubhouse.feedback.connect(invitation);
      setStatus(result.status);
      setMessage(result.connected ? 'Connected.' : connectFailedMessage(result.status.notice));
      if (result.connected) {
        // telemetry-exempt: optional offer; without it Feedback still works and the panel stays off.
        setShareAsk(await framebriarTelemetryAsk().catch((): null => null));
      }
    } catch (err) {
      // telemetry-exempt: shown to the user
      setMessage(`Couldn't connect. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.clubhouse.feedback.disconnect();
      setStatus(result.status);
      if (!result.forgotten) setMessage('Couldn\'t disconnect. The saved access couldn\'t be removed from secure storage.');
      else if (result.revoked === false) setMessage('Disconnected here. The server couldn\'t be told; the access will lapse on its own.');
      else setMessage('Disconnected.');
    } catch (err) {
      // telemetry-exempt: shown to the user
      setMessage(`Couldn't disconnect. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    const ask = shareAsk;
    setShareAsk(null);
    if (!ask) return;
    const result = await window.clubhouse.telemetrySettings.setEnabled('framebriar', true, { host: ask.host });
    setMessage(result.ok ? 'Connected. Telemetry is shared with the developer too.' : 'Connected. Telemetry sharing didn\'t start; see Settings, Logging.');
  };
  const declineShare = () => {
    setShareAsk(null);
    // Record the choice, so telemetry never turns it on behind the user's back.
    void window.clubhouse.telemetrySettings.setEnabled('framebriar', false).catch((): undefined => undefined);
  };

  const expires = formatDate(status.expiresAt);
  const storageUnavailable = !status.storage.available;
  const stateText = STATE_TEXT[status.state];

  return (
    <SettingsPage
      title="Feedback"
      description="Connecting lets you send feedback and screenshots to the developer."
      testId="feedback-settings"
    >
      <p className={`${settingsHelp} mt-3`}>
        If telemetry export is on (Settings, Logging), Clubhouse then asks whether to share user activity and errors with the developer too, with the same redaction as your own export. Nothing is shared unless you agree.
      </p>

      {storageUnavailable && (
        <p className="text-xs text-ctp-warning mt-3" data-testid="feedback-storage-unavailable">
          Feedback needs your {keyringName()} to keep its credential safe, and it isn&apos;t available. Clubhouse never stores the credential in plain text.
        </p>
      )}

      {status.notice && (
        <p className="text-xs text-ctp-warning mt-3" role="status" data-testid="feedback-notice">{FEEDBACK_NOTICE_TEXT[status.notice]}</p>
      )}

      <SettingsSection title="Connection">
        {status.connected ? (
          <SettingsField
            testId="feedback-connected"
            label={<>Connected{expires ? <span className="text-ctp-overlay1"> · access expires {expires}</span> : null}</>}
          >
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className={settingsButton.ghost}
            >
              Disconnect
            </button>
          </SettingsField>
        ) : (
          <form onSubmit={(e) => void connect(e)} data-testid="feedback-connect-form">
            <SettingsField
              label="Invitation"
              htmlFor="feedback-invitation"
              help={status.enrolled && expires ? `Previous access expires ${expires}.` : 'Paste the invitation you were sent. No URL or key needed.'}
            >
              <input
                id="feedback-invitation"
                ref={inputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={busy || storageUnavailable}
                placeholder="Paste the invitation you were sent"
                className={`${settingsInput} w-[240px]`}
              />
              <button
                type="submit"
                disabled={busy || storageUnavailable}
                className={settingsButton.primary}
              >
                Connect
              </button>
            </SettingsField>
          </form>
        )}

        {/* Offline, expired or revoked access is still an enrollment: Disconnect clears it and its notice. */}
        {!status.connected && (status.enrolled || status.notice) && (
          <SettingsField testId="feedback-enrolled" label="Saved access" help="Feedback access is saved on this computer.">
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className={settingsButton.ghost}
            >
              Disconnect
            </button>
          </SettingsField>
        )}
      </SettingsSection>

      {stateText && <p className={`${settingsHelp} mt-2`} data-testid="feedback-state">{stateText}</p>}
      {message && <p className="text-xs text-ctp-subtext1 mt-2" role="status" data-testid="feedback-message">{message}</p>}

      {shareAsk && <FeedbackTelemetryPrompt ask={shareAsk} onShare={() => void share()} onDecline={declineShare} />}

      {(status.outbox.pending > 0 || status.outbox.blocked > 0) && (
        <p className={`${settingsHelp} mt-2`} data-testid="feedback-outbox">
          {status.outbox.pending > 0 && `${status.outbox.pending} ${status.outbox.pending === 1 ? 'report is' : 'reports are'} saved and waiting to send.`}
          {status.outbox.blocked > 0 && ` ${status.outbox.blocked} couldn't be delivered and are kept on this computer.`}
        </p>
      )}
    </SettingsPage>
  );
}
