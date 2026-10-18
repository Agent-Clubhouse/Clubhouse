import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore } from '../../stores/feedbackStore';
import { FeedbackSettingsView } from './FeedbackSettingsView';
import { feedbackStatus, setFeedback } from '../feedback/feedback-test-utils';

const disconnected = feedbackStatus({ state: 'disconnected', connected: false, enrolled: false, canCapture: false, expiresAt: null });

beforeEach(() => {
  window.clubhouse.feedback.connect = vi.fn();
  window.clubhouse.feedback.disconnect = vi.fn();
});
afterEach(() => resetFeedbackStore());

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
    ['connection-uncertain', /may still have accepted the invitation, so try the same one again/],
    ['access-required', /wasn't accepted\. It may have expired, been revoked or been used up/],
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
