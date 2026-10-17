import { useEffect, useRef, useState } from 'react';
import { FEEDBACK_NOTICE_TEXT, useFeedbackStore } from '../../stores/feedbackStore';

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

const STATE_TEXT: Record<string, string> = {
  checking: 'Checking…',
  connecting: 'Connecting…',
  disconnecting: 'Disconnecting…',
  offline: 'Offline. Feedback is saved and sent when Clubhouse is back online.',
  stopped: 'Paused.',
};

/**
 * Settings › Feedback: connect with an invitation (the only thing needed: no URL or key),
 * see the connection and its expiry, disconnect. Behind the experimental Feedback switch.
 */
export function FeedbackSettingsView() {
  const enabled = useFeedbackStore((s) => s.enabled);
  const status = useFeedbackStore((s) => s.status);
  const init = useFeedbackStore((s) => s.init);
  const setStatus = useFeedbackStore((s) => s.setStatus);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void init(); }, [init]);

  if (!enabled || !status) {
    return (
      <div className="h-full overflow-y-auto bg-ctp-base p-6" data-testid="feedback-settings">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Feedback</h2>
        <p className="text-sm text-ctp-subtext0">Turn on Feedback in Settings, Experimental to send screenshot feedback.</p>
      </div>
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
      setMessage(result.connected ? 'Connected.' : 'Couldn\'t connect with that invitation.');
    } catch (err) {
      // telemetry-exempt: shown to the user
      setMessage(`Couldn't connect: ${err instanceof Error ? err.message : String(err)}`);
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
      setMessage(result.revoked === false
        ? 'Disconnected here. The server couldn\'t be told; the access will lapse on its own.'
        : 'Disconnected.');
    } catch (err) {
      // telemetry-exempt: shown to the user
      setMessage(`Couldn't disconnect: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const expires = formatDate(status.expiresAt);
  const storageUnavailable = !status.storage.available;
  const stateText = STATE_TEXT[status.state];

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6" data-testid="feedback-settings">
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-ctp-text mb-1">Feedback</h2>
          <p className="text-sm text-ctp-subtext0">
            Send screenshots and notes about Clubhouse to its developer. Connecting lets you send feedback and screenshots to the developer.
          </p>
        </div>

        {storageUnavailable && (
          <p className="text-sm text-ctp-subtext1" data-testid="feedback-storage-unavailable">
            Feedback needs your {keyringName()} to keep its credential safe, and it isn't available. Clubhouse never stores the credential in plain text.
          </p>
        )}

        {status.notice && (
          <p className="text-sm text-ctp-warning" role="status" data-testid="feedback-notice">{FEEDBACK_NOTICE_TEXT[status.notice]}</p>
        )}

        {status.connected ? (
          <div className="flex items-center justify-between gap-3" data-testid="feedback-connected">
            <div className="text-sm text-ctp-text">
              Connected{expires ? <span className="text-ctp-subtext0"> · access expires {expires}</span> : null}
            </div>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className="px-3 py-1.5 text-sm rounded-md bg-surface-0 text-ctp-text hover:bg-surface-1 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void connect(e)} className="space-y-2" data-testid="feedback-connect-form">
            <label htmlFor="feedback-invitation" className="block text-sm text-ctp-text">Invitation</label>
            <div className="flex gap-2">
              <input
                id="feedback-invitation"
                ref={inputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={busy || storageUnavailable}
                placeholder="Paste the invitation you were sent"
                className="flex-1 px-3 py-1.5 text-sm rounded-md bg-ctp-mantle border border-surface-1 text-ctp-text placeholder:text-ctp-overlay0 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy || storageUnavailable}
                className="px-3 py-1.5 text-sm rounded-md bg-ctp-accent text-white disabled:opacity-50"
              >
                Connect
              </button>
            </div>
            {status.enrolled && expires && (
              <p className="text-xs text-ctp-subtext0">Previous access expires {expires}.</p>
            )}
          </form>
        )}

        {stateText && <p className="text-sm text-ctp-subtext0" data-testid="feedback-state">{stateText}</p>}
        {message && <p className="text-sm text-ctp-subtext1" role="status" data-testid="feedback-message">{message}</p>}

        {(status.outbox.pending > 0 || status.outbox.blocked > 0) && (
          <p className="text-sm text-ctp-subtext0" data-testid="feedback-outbox">
            {status.outbox.pending > 0 && `${status.outbox.pending} ${status.outbox.pending === 1 ? 'report is' : 'reports are'} saved and waiting to send.`}
            {status.outbox.blocked > 0 && ` ${status.outbox.blocked} couldn't be delivered and are kept on this computer.`}
          </p>
        )}
      </div>
    </div>
  );
}
