import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_NOTICE_TEXT, resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { clearResultText, releaseResultText } from './FeedbackHeldReports';
import { connectFailedMessage, FeedbackSettingsView } from './FeedbackSettingsView';
import { feedbackStatus, setFeedback } from '../feedback/feedback-test-utils';

const withHeld = (held: number, bytes: number, releaseToken: string | null, over: Parameters<typeof feedbackStatus>[0] = {}, clearToken: string | null = held > 0 ? 'clear-token' : null) => {
  const base = feedbackStatus(over);
  return { ...base, outbox: { ...base.outbox, pending: held, heldForEnrollment: held, heldBytes: bytes, releaseToken, clearToken } };
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
    expect(screen.getByTestId('feedback-held-confirm').textContent).toMatch(/2 reports held on this computer will be queued to send/);
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
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('1 report queued to send. 1 still held. Try Send again.');
    expect(held()).toMatch(/1 report held/);
  });

  it('a release that failed outright says the report is still held, and Send stays on', async () => {
    setFeedback(true, withHeld(1, 0, 'token-a'));
    release().mockResolvedValue({ released: 0, remaining: 1, failed: 1, status: withHeld(1, 0, 'token-a') });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('0 reports queued to send. 1 still held. Try Send again.');
    expect(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  it('a stale release before status catches up says so, rather than asking with the same token', async () => {
    setFeedback(true, withHeld(1, 0, 'token-a'));
    release().mockResolvedValue({ released: 0, remaining: 2, failed: 0, code: 'stale-release', status: withHeld(1, 0, 'token-a') });
    render(<FeedbackSettingsView />);
    openSend();
    await confirm('Send');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('feedback-held-message').textContent).toBe('The held reports changed. Nothing was queued.');
  });

  describe('Clear', () => {
    const openClear = () => fireEvent.click(within(screen.getByTestId('feedback-held')).getByRole('button', { name: 'Clear' }));

    it('clears with the token shown when the confirmation opened, even if status moved on', async () => {
      setFeedback(true, withHeld(2, 0, 'token-a', {}, 'clear-shown'));
      clear().mockResolvedValue({ cleared: 2, remaining: 0, failed: 0, status: none });
      render(<FeedbackSettingsView />);
      openClear();
      expect(clear()).not.toHaveBeenCalled();
      act(() => { useFeedbackStore.setState({ status: withHeld(3, 0, 'token-b', {}, 'clear-newer') }); });
      expect(screen.getByTestId('feedback-held-confirm').textContent).toMatch(/2 reports will be deleted/);
      await confirm('Clear');
      expect(clear()).toHaveBeenCalledTimes(1);
      expect(clear()).toHaveBeenCalledWith('clear-shown');
      expect(window.clubhouse.feedback.getStatus).not.toHaveBeenCalled();
    });

    it('a stale token deletes nothing and asks again with the new count and token', async () => {
      setFeedback(true, withHeld(2, 0, 'token-a', {}, 'clear-old'));
      clear().mockResolvedValueOnce({ cleared: 0, remaining: 3, failed: 0, code: 'stale-release', status: withHeld(3, 0, 'token-b', {}, 'clear-new') });
      render(<FeedbackSettingsView />);
      openClear();
      await confirm('Clear');
      expect(clear()).toHaveBeenCalledTimes(1);
      const asked = screen.getByTestId('feedback-held-confirm').textContent ?? '';
      expect(asked).toMatch(/The held reports changed\. Check the count and confirm again\./);
      expect(asked).toMatch(/3 reports will be deleted/);
      expect(useFeedbackStore.getState().status?.outbox.clearToken).toBe('clear-new');
      clear().mockResolvedValueOnce({ cleared: 3, remaining: 0, failed: 0, status: none });
      await confirm('Clear');
      expect(clear()).toHaveBeenLastCalledWith('clear-new');
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('3 reports cleared.');
    });

    it('a stale token with nothing left to clear stops asking, in its own words', async () => {
      setFeedback(true, withHeld(1, 0, 'token-a'));
      clear().mockResolvedValue({ cleared: 0, remaining: 0, failed: 0, code: 'stale-release', status: none });
      render(<FeedbackSettingsView />);
      openClear();
      await confirm('Clear');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('The held reports changed. Nothing was cleared.');
    });

    it('a stale token before status catches up says so, rather than asking with the same token', async () => {
      setFeedback(true, withHeld(1, 0, 'token-a', {}, 'clear-a'));
      clear().mockResolvedValue({ cleared: 0, remaining: 2, failed: 0, code: 'stale-release', status: withHeld(1, 0, 'token-a', {}, 'clear-a') });
      render(<FeedbackSettingsView />);
      openClear();
      await confirm('Clear');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('The held reports changed. Nothing was cleared.');
    });

    it('says what a failed clear leaves behind', async () => {
      setFeedback(true, withHeld(2, 0, 'token-a'));
      clear().mockResolvedValue({ cleared: 1, remaining: 1, failed: 1, status: withHeld(1, 0, 'token-b') });
      render(<FeedbackSettingsView />);
      openClear();
      await confirm('Clear');
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('1 report cleared. 1 still held. Try Clear again.');
    });

    it('says when storage stopped it, and that nothing went', async () => {
      setFeedback(true, withHeld(1, 0, 'token-a'));
      clear().mockResolvedValue({ cleared: 0, remaining: 1, failed: 0, code: 'storage-unavailable', status: withHeld(1, 0, 'token-a') });
      render(<FeedbackSettingsView />);
      openClear();
      await confirm('Clear');
      expect(screen.getByTestId('feedback-held-message').textContent).toBe('Couldn\'t read saved feedback on this computer. Nothing was cleared. Try Clear again. If it keeps happening, restart Clubhouse.');
    });

    it('is off with no token, and says why', () => {
      setFeedback(true, withHeld(2, 0, null, {}, null));
      render(<FeedbackSettingsView />);
      const area = within(screen.getByTestId('feedback-held'));
      expect(area.getByRole('button', { name: 'Clear' })).toBeDisabled();
      expect(area.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(held()).toMatch(/Couldn't read saved feedback on this computer, so these can't be sent or cleared right now\./);
    });

    const WHY = 'These reports are waiting for your choice. They may be from an earlier feedback connection, or their saved state can\'t be read right now.';

    it.each([
      ['token-a', 'They stay on this computer until you send or clear them.'],
      [null, 'Send isn\'t available without a working connection.'],
    ])('names both reasons a report is held, with release token %s', (releaseToken, rest) => {
      setFeedback(true, withHeld(1, 0, releaseToken));
      render(<FeedbackSettingsView />);
      expect(held()).toContain(`${WHY} ${rest}`);
      expect(held()).not.toMatch(/usually|because|Framebriar|\u2014/);
    });

    it.each([
      ['token-a', 'A held report may be one that could still be sent. To queue them to send instead, choose Cancel, then Send.'],
      [null, 'A held report may be one that could still be sent. Send isn\'t available without a working connection, so choose Cancel to keep them.'],
    ])('says before deleting that a held report may still be sendable, with release token %s', (releaseToken, line) => {
      setFeedback(true, withHeld(1, 0, releaseToken));
      render(<FeedbackSettingsView />);
      openClear();
      const asked = screen.getByTestId('feedback-held-confirm').textContent ?? '';
      expect(asked).toContain('1 report will be deleted from this computer. They can\'t be sent after this.');
      expect(asked).toContain(line);
      expect(asked).not.toMatch(/earlier|delivered|Framebriar|\u2014/);
    });
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
    expect(clear()).toHaveBeenCalledWith('clear-token');
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
    [{ released: 0, remaining: 2, failed: 0, code: 'storage-unavailable' as const }, /^Couldn't read saved feedback on this computer\. Nothing was queued\. Try Send again\. If it keeps happening, restart Clubhouse\.$/],
  ])('explains %o', (result, text) => {
    expect(releaseResultText(result)).toMatch(text);
  });

  it('keeps every line of copy to the rules', () => {
    const lines = [
      releaseResultText({ released: 1, remaining: 1, failed: 1 }),
      releaseResultText({ released: 0, remaining: 0, failed: 0, code: 'stale-release' }),
      releaseResultText({ released: 0, remaining: 1, failed: 0, code: 'storage-unavailable' }),
      clearResultText({ cleared: 1, remaining: 1, failed: 1 }),
      clearResultText({ cleared: 0, remaining: 1, failed: 0, code: 'storage-unavailable' }),
      clearResultText({ cleared: 0, remaining: 1, failed: 0, code: 'stale-release' }),
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
      expect(clear()).toHaveBeenCalledWith('clear-token');
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
      expect(clear()).toHaveBeenCalledWith('clear-token');
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

  it.each([
    ['expired', 'connect with a new invitation'],
    ['access-required', 'connect with a new invitation'],
    ['connection-uncertain', 'connect again'],
  ] as const)('with the %s notice, says saved reports need a connection and a Send', (notice, connect) => {
    const status = feedbackStatus({ ...disconnected, state: notice, notice, enrolled: true, canCapture: true });
    setFeedback(true, { ...status, outbox: { ...status.outbox, pending: 2, correlationWaiting: 1 } });
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-outbox').textContent).toBe(`2 reports are saved on this computer and can't be sent yet. To send, ${connect}, then choose Send under Held reports. To delete, choose Disconnect, then Clear under Held reports.`);
  });

  it('offline still says waiting to send', () => {
    const status = feedbackStatus({ ...disconnected, state: 'offline', enrolled: true, canCapture: true });
    setFeedback(true, { ...status, outbox: { ...status.outbox, pending: 2 } });
    render(<FeedbackSettingsView />);
    expect(screen.getByTestId('feedback-outbox').textContent).toBe('2 reports are saved and waiting to send.');
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
        consentAccepted: true,
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
      consentAccepted: true, destinations: [dest('azure', { enabled: true }), dest('framebriar', { userOff: true })],
    } as never);
    await connect();
    expect(screen.queryByTestId('feedback-telemetry-prompt')).toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('asks even with no other destination on, and the prompt is the consent then (#2097)', async () => {
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue({
      consentAccepted: false, destinations: [dest('azure'), dest('framebriar')],
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

  it('says export is paused and offers Resume on the Feedback page too', async () => {
    const status = { consentAccepted: true, exportPaused: true, destinations: [dest('framebriar')] };
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue(status as never);
    const resume = vi.fn(async () => ({ ok: true, status: { ...status, exportPaused: false } }));
    window.clubhouse.telemetrySettings.resume = resume as never;
    setFeedback(true);
    render(<FeedbackSettingsView />);
    await act(async () => {});
    expect(screen.getByTestId('telemetry-paused')).toHaveTextContent('Other experimental settings may not be as you left them.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume' })); });
    expect(resume).toHaveBeenCalled();
    expect(screen.queryByTestId('telemetry-paused')).toBeNull();
  });

  it('hides the developer switch when there is no developer destination to show (#2097)', async () => {
    vi.mocked(window.clubhouse.telemetrySettings.getStatus).mockResolvedValue({ destinations: [] } as never);
    setFeedback(true);
    render(<FeedbackSettingsView />);
    await act(async () => {});
    expect(screen.queryByTestId('developer-telemetry')).toBeNull();
  });
});
