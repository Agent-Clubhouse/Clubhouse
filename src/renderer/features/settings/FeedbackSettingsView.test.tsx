import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_NOTICE_TEXT, resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { clearResultText, releaseResultText } from './FeedbackHeldReports';
import { connectFailedMessage, FeedbackSettingsView } from './FeedbackSettingsView';
import { feedbackStatus, setFeedback } from '../feedback/feedback-test-utils';

const withHeld = (held: number, bytes: number, releaseToken: string | null, over: Parameters<typeof feedbackStatus>[0] = {}) => {
  const base = feedbackStatus(over);
  return { ...base, outbox: { ...base.outbox, pending: held, heldForEnrollment: held, heldBytes: bytes, releaseToken } };
};
const disconnected = feedbackStatus({ state: 'disconnected', connected: false, enrolled: false, canCapture: false, expiresAt: null });

beforeEach(() => {
  window.clubhouse.feedback.connect = vi.fn();
  window.clubhouse.feedback.disconnect = vi.fn();
  window.clubhouse.feedback.releaseHeld = vi.fn();
  window.clubhouse.feedback.clearHeld = vi.fn();
  window.clubhouse.feedback.getStatus = vi.fn();
});
afterEach(() => resetFeedbackStore());

describe('held reports', () => {
  const release = () => vi.mocked(window.clubhouse.feedback.releaseHeld);
  const clear = () => vi.mocked(window.clubhouse.feedback.clearHeld);
  const held = () => screen.getByTestId('feedback-held').textContent ?? '';
  const none = withHeld(0, 0, null);
  const openSend = () => fireEvent.click(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Send' }));
  const confirm = (name: string) => act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name })); });

  it('shows nothing when no report is held', () => {
    setFeedback(true);
    render(<FeedbackSettingsView />);
    expect(screen.queryByTestId('feedback-held')).toBeNull();
  });

  it('shows the count and size, naming no account, and held reports are not waiting to send', () => {
    setFeedback(true, withHeld(2, 2 * 1024 * 1024, 'token-a'));
    render(<FeedbackSettingsView />);
    expect(held()).toMatch(/2 reports held \(2\.0 MB\)/);
    expect(held()).toMatch(/earlier feedback connection/);
    expect(held()).not.toMatch(/account|@|token/i);
    expect(screen.queryByTestId('feedback-outbox')).toBeNull();
  });

  it('counts only what is really waiting', () => {
    const status = withHeld(1, 10, 'token-a');
    setFeedback(true, { ...status, outbox: { ...status.outbox, pending: 3 } });
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-outbox').textContent).toMatch(/^2 reports are saved and waiting to send\./);
  });

  it('releases with the token shown when the confirmation opened, even if status moved on', async () => {
    setFeedback(true, withHeld(2, 0, 'token-shown'));
    release().mockResolvedValue({ released: 0, remaining: 0, failed: 0, status: none });
    render(<FeedbackSettingsView />);
    openSend();
    expect(screen.getByTestId('feedback-held-confirm').textContent).toMatch(/2 reports saved under an earlier feedback connection will be queued to send/);
    expect(release()).not.toHaveBeenCalled();
    act(() => { useFeedbackStore.setState({ status: withHeld(3, 0, 'token-newer') }); });
    expect(screen.getByTestId('feedback-held-confirm').textContent).toMatch(/2 reports/);
    await confirm('Send');
    expect(release()).toHaveBeenCalledTimes(1);
    expect(release()).toHaveBeenCalledWith('token-shown');
    expect(window.clubhouse.feedback.getStatus).not.toHaveBeenCalled();
  });

  it('says queued after a release, never Sent', async () => {
    setFeedback(true, withHeld(2, 0, 'token-a'));
    release().mockResolvedValue({ released: 2, remaining: 0, failed: 0, status: none });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    const message = screen.getByTestId('feedback-held-message').textContent ?? '';
    expect(message).toBe('2 reports queued to send.');
    expect(message).not.toMatch(/\bSent\b/i);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a stale token refreshes and asks again, and nothing moves without a new confirmation', async () => {
    setFeedback(true, withHeld(2, 0, 'token-old'));
    release().mockResolvedValueOnce({ released: 0, remaining: 3, failed: 0, code: 'stale-release', status: withHeld(3, 0, 'token-new') });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    expect(release()).toHaveBeenCalledTimes(1);
    const asked = screen.getByTestId('feedback-held-confirm').textContent ?? '';
    expect(asked).toMatch(/changed/);
    expect(asked).toMatch(/3 reports/);
    expect(useFeedbackStore.getState().status?.outbox.releaseToken).toBe('token-new');
    release().mockResolvedValueOnce({ released: 3, remaining: 0, failed: 0, status: none });
    await confirm('Send');
    expect(release()).toHaveBeenLastCalledWith('token-new');
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('3 reports queued to send.');
  });

  it('a stale token with nothing left to send stops asking', async () => {
    setFeedback(true, withHeld(1, 0, 'token-old'));
    release().mockResolvedValue({ released: 0, remaining: 0, failed: 0, code: 'stale-release', status: none });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('The held reports changed. Nothing was queued.');
  });

  it('shows released, remaining and failed after a partial release', async () => {
    setFeedback(true, withHeld(2, 0, 'token-a'));
    release().mockResolvedValue({ released: 1, remaining: 1, failed: 1, status: withHeld(1, 0, 'token-b') });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('1 report queued to send. 1 still held. 1 failed.');
    expect(held()).toMatch(/1 report held/);
  });

  it('unenrolled: Send is off and says to connect, and Clear still works', async () => {
    setFeedback(true, withHeld(2, 0, null, { state: 'disconnected', connected: false, enrolled: false, canCapture: false, expiresAt: null }));
    clear().mockResolvedValue({ cleared: 2, remaining: 0, failed: 0, status: none });
    render(<FeedbackSettingsView />);
    const area = within(screen.getByTestId('feedback-held'));
    expect((area.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(held()).toMatch(/connect and send/);
    fireEvent.click(area.getByRole('button', { name: 'Clear' }));
    expect(clear()).not.toHaveBeenCalled();
    expect(screen.getByTestId('feedback-held-confirm').textContent).toMatch(/2 reports will be deleted/);
    await confirm('Clear');
    expect(clear()).toHaveBeenCalledTimes(1);
    expect(release()).not.toHaveBeenCalled();
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('2 reports cleared.');
  });

  it('Cancel leaves everything held', () => {
    setFeedback(true, withHeld(2, 0, 'token-a'));
    render(<FeedbackSettingsView />);
    openSend();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(release()).not.toHaveBeenCalled();
    expect(held()).toMatch(/2 reports held/);
  });

  it.each([
    [{ released: 0, remaining: 2, failed: 0, code: 'not-enrolled' as const }, /Connect to Feedback/],
    [{ released: 0, remaining: 2, failed: 0, code: 'storage-unavailable' as const }, /Nothing was queued/],
  ])('explains %o', (result, text) => {
    expect(releaseResultText(result)).toMatch(text);
  });

  it('keeps every line of copy to the rules', () => {
    const lines = [
      releaseResultText({ released: 1, remaining: 1, failed: 1 }),
      releaseResultText({ released: 0, remaining: 0, failed: 0, code: 'stale-release' }),
      clearResultText({ cleared: 1, remaining: 1, failed: 1 }),
      clearResultText({ cleared: 0, remaining: 1, failed: 0, code: 'storage-unavailable' }),
    ].join(' ');
    expect(lines).not.toMatch(/\u2014/);
    expect(lines).not.toMatch(/\bSent\b/i);
  });
});

describe('FeedbackSettingsView', () => {
  it('says Feedback is unavailable when main reports no status', () => {
    setFeedback(false);
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-settings').textContent).toMatch(/isn't available right now/);
    expect(screen.queryByLabelText('Invitation')).toBeNull();
  });

  it('connects with an invitation only, clearing the field at once', async () => {
    setFeedback(true, disconnected);
    let resolve!: (v: unknown) => void;
    vi.mocked(window.clubhouse.feedback.connect).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-settings').textContent).toContain('Connecting lets you send feedback and screenshots to the developer.');
    expect(screen.getByTestId('feedback-settings').textContent).toContain('After you connect, Clubhouse asks whether to share user activity and errors with the developer too.');
    const input = screen.getByLabelText('Invitation') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: '  the-invitation  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // Cleared before the redemption finishes.
    expect(input.value).toBe('');
    expect(window.clubhouse.feedback.connect).toHaveBeenCalledWith('the-invitation');
    await act(async () => { resolve({ connected: true, status: feedbackStatus() }); });
    expect(screen.getByTestId('feedback-connected').textContent).toMatch(/Connected · access expires/);
  });

  it.each([
    ['connection-uncertain', /may still have accepted the invitation, so try the same one again\. If it's refused, ask for a new one\.$/],
    ['access-required', /wasn't accepted\. It may have expired, been revoked or been used up\. Ask for a new one\.$/],
    [null, /^Couldn't connect with that invitation\.$/],
  ] as const)('explains a failed connect with notice %s', async (notice, text) => {
    setFeedback(true, disconnected);
    vi.mocked(window.clubhouse.feedback.connect).mockResolvedValue({ connected: false, status: { ...disconnected, notice } } as never);
    render(<FeedbackSettingsView />);
    fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'inv' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(screen.getByTestId('feedback-message').textContent).toMatch(text);
  });

  it('shows the connection, its expiry and Disconnect', async () => {
    setFeedback(true);
    vi.mocked(window.clubhouse.feedback.disconnect).mockResolvedValue({ forgotten: true, revoked: true, status: disconnected });
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-connected').textContent).toContain('2026');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(screen.getByTestId('feedback-message').textContent).toBe('Disconnected.');
    expect(screen.getByLabelText('Invitation')).toBeTruthy();
  });

  it('lets an enrolled user who is offline or has a notice disconnect and clear it', async () => {
    setFeedback(true, feedbackStatus({ ...disconnected, state: 'offline', enrolled: true, canCapture: true, notice: null }));
    vi.mocked(window.clubhouse.feedback.disconnect).mockResolvedValue({ forgotten: true, revoked: true, status: disconnected });
    const { unmount } = render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-state').textContent).toMatch(/Offline/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(window.clubhouse.feedback.disconnect).toHaveBeenCalled();
    expect(screen.queryByTestId('feedback-enrolled')).toBeNull();
    unmount();

    setFeedback(true, feedbackStatus({ ...disconnected, enrolled: false, notice: 'access-required' }));
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-notice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('says so when the saved access could not be removed', async () => {
    setFeedback(true);
    vi.mocked(window.clubhouse.feedback.disconnect).mockResolvedValue({ forgotten: false, revoked: false, status: feedbackStatus() });
    render(<FeedbackSettingsView />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(screen.getByTestId('feedback-message').textContent).toMatch(/couldn't be removed from secure storage/);
  });

  it('hides Disconnect when never enrolled', () => {
    setFeedback(true, disconnected);
    render(<FeedbackSettingsView />);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it.each([
    ['expired', /access expired/],
    ['access-required', /revoked/],
    ['connection-uncertain', /couldn't confirm/],
  ] as const)('shows the %s notice', (notice, text) => {
    setFeedback(true, feedbackStatus({ ...disconnected, enrolled: true, canCapture: true, notice }));
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-notice').textContent).toMatch(text);
  });

  it('explains when the system keyring is unavailable, and disables Connect', () => {
    setFeedback(true, feedbackStatus({ ...disconnected, state: 'storage-unavailable', storage: { available: false, reason: 'plaintext-backend' } }));
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-storage-unavailable').textContent).toMatch(/never stores the credential in plain text/);
    expect(screen.getByRole('button', { name: 'Connect' }).hasAttribute('disabled')).toBe(true);
  });

  describe('after a rejected connection', () => {
    const release = () => vi.mocked(window.clubhouse.feedback.releaseHeld);
    const clear = () => vi.mocked(window.clubhouse.feedback.clearHeld);
    const held = () => screen.getByTestId('feedback-held').textContent ?? '';
    const none = withHeld(0, 0, null);
    const openSend = () => fireEvent.click(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Send' }));
    const REJECTION = 'That invitation was used, but Clubhouse couldn\'t finish connecting. Update Clubhouse, or ask for a new invitation. If it keeps happening, check your computer\'s date and time.';
    const rejected = (pending = 0, over: Parameters<typeof feedbackStatus>[0] = {}) => {
      const base = feedbackStatus({ ...disconnected, state: 'enrollment-response-rejected', notice: 'enrollment-response-rejected', enrolled: true, canCapture: true, expiresAt: null, ...over });
      return { ...base, outbox: { ...base.outbox, pending } };
    };

    it('has the agreed message, which offers no retry and names no service', () => {
      expect(connectFailedMessage('enrollment-response-rejected')).toBe(REJECTION);
      expect(FEEDBACK_NOTICE_TEXT['enrollment-response-rejected']).toBe(REJECTION);
      expect(REJECTION).not.toMatch(/try again|same one|Framebriar|—/i);
    });

    it('uses plain words in every notice', () => {
      for (const text of Object.values(FEEDBACK_NOTICE_TEXT)) expect(text).not.toMatch(/Framebriar|enrollment|—/i);
    });

    it('shows the message once after a failed connect, and doesn\'t say connected', async () => {
      setFeedback(true, disconnected);
      vi.mocked(window.clubhouse.feedback.connect).mockResolvedValue({ connected: false, status: rejected() } as never);
      render(<FeedbackSettingsView />);
      fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'inv' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
      expect(screen.getByTestId('feedback-notice').textContent).toBe(REJECTION);
      expect(screen.queryByTestId('feedback-message')).toBeNull();
      expect(screen.queryByTestId('feedback-connected')).toBeNull();
      expect(screen.getByTestId('feedback-settings').textContent).not.toMatch(/Connected|invalid-|wrong-game|access is saved/);
      expect(screen.getByLabelText('Invitation')).toBeTruthy();
    });

    it('says why the saved reports can\'t go, what to do, and how to delete them, with no Send to press', () => {
      setFeedback(true, rejected(2));
      render(<FeedbackSettingsView />);
      const text = screen.getByTestId('feedback-outbox').textContent;
      expect(text).toBe('2 reports are saved on this computer and can\'t be sent yet. To send, connect with a new invitation, then choose Send under Held reports. To delete, choose Disconnect, then Clear under Held reports.');
      expect(screen.queryByTestId('feedback-held')).toBeNull();
    });

    it('doesn\'t blame the service for tracing references while there is no connection', () => {
      const status = rejected(1);
      setFeedback(true, { ...status, outbox: { ...status.outbox, correlationWaiting: 1 } });
      render(<FeedbackSettingsView />);
      expect(screen.getByTestId('feedback-outbox').textContent).not.toMatch(/tracing references/);
    });

    it('Disconnect clears it and leaves the reports to clear, held', async () => {
      setFeedback(true, rejected(2));
      const after = withHeld(2, 0, null, { ...disconnected });
      vi.mocked(window.clubhouse.feedback.disconnect).mockResolvedValue({ forgotten: true, revoked: null, status: after });
      clear().mockResolvedValue({ cleared: 2, remaining: 0, failed: 0, status: none });
      render(<FeedbackSettingsView />);
      expect(screen.getByTestId('feedback-enrolled').textContent).toMatch(/Failed connection.*Disconnect clears this message, and saved reports stay on this computer/);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
      expect(screen.queryByTestId('feedback-notice')).toBeNull();
      expect(held()).toMatch(/2 reports held/);
      expect(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Send' })).toBeDisabled();
      fireEvent.click(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Clear' }));
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear' })); });
      expect(clear()).toHaveBeenCalledOnce();
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('2 reports cleared.');
    });

    it('with reports already held: Send is off and says why, and Clear works', async () => {
      const status = withHeld(1, 0, null, { ...rejected(1) });
      setFeedback(true, status);
      clear().mockResolvedValue({ cleared: 1, remaining: 0, failed: 0, status: rejected() });
      render(<FeedbackSettingsView />);
      expect(held()).toMatch(/Send isn't available without a working connection\. You can clear them now, or connect and send them\./);
      const area = within(screen.getByTestId('feedback-held'));
      expect(area.getByRole('button', { name: 'Send' })).toBeDisabled();
      fireEvent.click(area.getByRole('button', { name: 'Clear' }));
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear' })); });
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('1 report cleared.');
    });

    it('a new connection turns them into held reports that Send releases with the token shown', async () => {
      setFeedback(true, rejected(2));
      const connected = withHeld(2, 0, 'token-after');
      vi.mocked(window.clubhouse.feedback.connect).mockResolvedValue({ connected: true, status: connected } as never);
      release().mockResolvedValue({ released: 2, remaining: 0, failed: 0, status: none });
      render(<FeedbackSettingsView />);
      fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'inv' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
      expect(screen.getByTestId('feedback-connected')).toBeTruthy();
      expect(release()).not.toHaveBeenCalled();
      openSend();
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send' })); });
      expect(release()).toHaveBeenCalledWith('token-after');
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('2 reports queued to send.');
    });
  });

  it('shows feedback waiting to send and blocked reports', () => {
    setFeedback(true, feedbackStatus({ outbox: { ...feedbackStatus().outbox, pending: 2, blocked: 1 } }));
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-outbox').textContent).toMatch(/2 reports are saved and waiting to send\. 1 couldn't be delivered/);
  });
});

describe('FeedbackSettingsView telemetry prompt', () => {
  const HOST = 'framebriar.example.net';
  const OTHER = 'westus2-1.in.applicationinsights.azure.com';
  const realTelemetry = window.clubhouse.telemetrySettings;
  let setEnabled: ReturnType<typeof vi.fn>;

  const dest = (id: string, o: Record<string, unknown> = {}) => ({
    id, kind: id, label: id === 'framebriar' ? 'Clubhouse developer' : id, enabled: false, level: 'standard', preset: 'user_activity',
    configured: true, active: false, health: { state: 'off' }, offlineQueue: false, ...o,
  });

  beforeEach(() => {
    setEnabled = vi.fn(async (_id: string, on: boolean, ack?: { host?: string }) =>
      (on && !ack?.host ? { ok: false, needs: ['destination'], host: HOST, hosts: [OTHER, HOST] } : { ok: true }));
    window.clubhouse.telemetrySettings = {
      ...realTelemetry,
      getStatus: vi.fn(async () => ({
        available: true, consentAccepted: true,
        destinations: [dest('azure', { enabled: true }), dest('framebriar')],
      })),
      setEnabled,
      setFilter: vi.fn(async () => ({ ok: true })),
      sendTest: vi.fn(async () => ({ ok: true, message: 'Sent.' })),
    } as never;
  });
  afterEach(() => { window.clubhouse.telemetrySettings = realTelemetry; });

  async function connect() {
    setFeedback(true, disconnected);
    vi.mocked(window.clubhouse.feedback.connect).mockResolvedValue({ connected: true, status: feedbackStatus() } as never);
    render(<FeedbackSettingsView />);
    fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'inv' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
  }

  it('asks to confirm the developer host when export is on, and Share enables it with that host', async () => {
    await connect();
    expect(screen.getByTestId('feedback-telemetry-hosts').textContent).toBe(OTHER + HOST);
    // Nothing is shared until confirmed.
    expect(setEnabled).not.toHaveBeenCalledWith('framebriar', true, { host: HOST });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Share' })); });
    expect(setEnabled).toHaveBeenLastCalledWith('framebriar', true, { host: HOST });
    expect(screen.queryByTestId('feedback-telemetry-prompt')).toBeNull();
    expect(screen.getByTestId('feedback-message').textContent).toBe('Connected. Telemetry is shared with the developer too.');
  });

  it('Not now records Off and leaves Feedback connected', async () => {
    await connect();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Not now' })); });
    expect(setEnabled).toHaveBeenLastCalledWith('framebriar', false);
    expect(screen.queryByTestId('feedback-telemetry-prompt')).toBeNull();
    expect(screen.getByTestId('feedback-connected')).toBeTruthy();
  });

  it('does not ask again after "Not now"', async () => {
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue({
      available: true, consentAccepted: true, destinations: [dest('azure', { enabled: true }), dest('framebriar', { userOff: true })],
    } as never);
    await connect();
    expect(screen.queryByTestId('feedback-telemetry-prompt')).toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('asks even with no other destination on, and the prompt is the consent then (#2097)', async () => {
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue({
      available: true, consentAccepted: false, destinations: [dest('azure'), dest('framebriar')],
    } as never);
    setEnabled.mockImplementation(async (_id: string, on: boolean, ack?: { host?: string }) =>
      (on && !ack?.host ? { ok: false, needs: ['consent', 'destination'], host: HOST, hosts: [HOST] } : { ok: true }));
    await connect();
    expect(screen.getByTestId('feedback-telemetry-hosts').textContent).toBe(HOST);
    expect(screen.getByTestId('feedback-telemetry-never-sent')).toHaveTextContent('File paths, repository URLs and branch names');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Share' })); });
    expect(setEnabled).toHaveBeenLastCalledWith('framebriar', true, { host: HOST, consent: true });
  });

  it('has the developer switch on the Feedback page, which asks before it shares (#2097)', async () => {
    setFeedback(true);
    render(<FeedbackSettingsView />);
    const section = await screen.findByTestId('developer-telemetry');
    expect(section).toHaveTextContent('Telemetry for the developer');
    expect(section.textContent).not.toMatch(/framebriar/i);
    await act(async () => { fireEvent.click(screen.getByLabelText('Send telemetry to the Clubhouse developer')); });
    expect(screen.getByTestId('feedback-telemetry-hosts').textContent).toBe(OTHER + HOST);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Share' })); });
    expect(setEnabled).toHaveBeenLastCalledWith('framebriar', true, { host: HOST });
  });

  it('hides the developer switch while telemetry is unavailable (#2097)', async () => {
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue({ available: false, destinations: [] } as never);
    setFeedback(true);
    render(<FeedbackSettingsView />);
    await act(async () => {});
    expect(screen.queryByTestId('developer-telemetry')).toBeNull();
  });
});
