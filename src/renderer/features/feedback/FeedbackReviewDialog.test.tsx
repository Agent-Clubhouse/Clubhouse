import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { useUIStore } from '../../stores/uiStore';
import { FeedbackDialogHost } from './FeedbackDialogHost';
import { FeedbackReviewDialog } from './FeedbackReviewDialog';
import { feedbackStatus, setFeedback } from './feedback-test-utils';
import type { FeedbackStatus } from '../../../shared/feedback-types';
import { compositeAnnotatedPng } from './annotation';

vi.mock('./annotation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./annotation')>()),
  compositeAnnotatedPng: vi.fn(),
}));

const DRAFT = { draftId: '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e', preview: 'data:image/png;base64,iVBORw0KGgo=' };
const send = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
  send.mockReset().mockResolvedValue({ id: 'rep-1', status: 'saved-local' });
  cancel.mockReset().mockResolvedValue(undefined);
  window.clubhouse.feedback.send = send;
  window.clubhouse.feedback.cancel = cancel;
  useUIStore.setState({ explorerTab: 'agents' });
  setFeedback(true);
});
afterEach(() => resetFeedbackStore());

describe('after a save whose earlier try had an unknown outcome', () => {
  it('says both may be delivered', async () => {
    useFeedbackStore.setState({ draft: DRAFT });
    send.mockResolvedValueOnce({ id: 'rep-2', status: 'saved-local', earlierMayDeliver: true });
    render(<FeedbackDialogHost />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    const text = screen.getByTestId('feedback-both-may-deliver').textContent ?? '';
    expect(text).toMatch(/may get both reports/);
    expect(text).not.toMatch(/framebriar|\u2014/i);
  });

  it('says nothing about it otherwise', async () => {
    useFeedbackStore.setState({ draft: DRAFT });
    render(<FeedbackDialogHost />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByTestId('feedback-sent-state')).toBeTruthy();
    expect(screen.queryByTestId('feedback-both-may-deliver')).toBeNull();
  });
});

describe('after an enrollment change', () => {
  const NEXT = {
    draftId: '1c6d7b3f-2a4e-4d9f-8b8c-3e5f7a9b1d2f', preview: 'data:image/png;base64,bmV3', shots: [{ shotId: 's0', label: 'Main window', preview: 'data:image/png;base64,bmV3' }],
    correlation: { scope: 'trace-only' as const, capturedAt: '2026-11-02T00:00:00.000Z', traceCount: 7, hostCount: 0, phoneCount: 0, connectionCount: 0 },
  };
  const OLD = { ...DRAFT, correlation: { ...NEXT.correlation, traceCount: 2 } };

  it('keeps the note and image, shows the new summary and waits for a new Send', async () => {
    useFeedbackStore.setState({ draft: OLD });
    send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: NEXT });
    render(<FeedbackDialogHost />);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'my note' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('feedback-reopened').textContent).toMatch(/nothing was sent/);
    expect(screen.queryByTestId('feedback-sent-state')).toBeNull();
    expect((screen.getByLabelText('What happened?') as HTMLTextAreaElement).value).toBe('my note');
    expect(screen.getByText(/7 trace\/span references/)).toBeTruthy();
    expect(screen.queryByText(/2 trace\/span references/)).toBeNull();
    expect((screen.getByRole('checkbox', { name: /Include tracing references/ }) as HTMLInputElement).checked).toBe(true);
    expect(useFeedbackStore.getState().draft?.draftId).toBe(NEXT.draftId);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: NEXT.draftId, notes: 'my note', shotId: 's0' }));
    expect(screen.getByTestId('feedback-sent-state')).toBeTruthy();
  });

  describe('what the user turned off', () => {
    const line = { at: '2026-11-01T12:00:00.000Z', level: 'warn' as const, ns: 'core:annex', event: 'annex.ws.disconnected' };
    const diagnostics = { status: 'available' as const, windowStart: line.at, windowEnd: line.at, lines: [line], bytes: 50, dropped: 0 };
    const tracing = () => screen.getByRole('checkbox', { name: /Include tracing references/ }) as HTMLInputElement;
    const lines = () => screen.getByRole('checkbox', { name: /Include recent diagnostics/ }) as HTMLInputElement;
    const tapSend = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

    it.each([
      ['diagnostics', false, true],
      ['tracing references', true, false],
      ['both', false, false],
      ['neither', true, true],
    ])('%s: choices survive the reopen and reach the new Send', async (_name, includeDiagnostics, includeCorrelation) => {
      useFeedbackStore.setState({ draft: { ...OLD, diagnostics } });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: { ...NEXT, diagnostics } });
      render(<FeedbackDialogHost />);
      if (!includeDiagnostics) fireEvent.click(lines());
      if (!includeCorrelation) fireEvent.click(tracing());
      await tapSend();
      expect(screen.getByTestId('feedback-reopened')).toBeTruthy();
      expect(lines().checked).toBe(includeDiagnostics);
      expect(tracing().checked).toBe(includeCorrelation);
      await tapSend();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: NEXT.draftId, includeDiagnostics, includeCorrelation }));
    });

    it('stays off through a second reopen', async () => {
      const THIRD = { ...NEXT, draftId: '2d7e8c4a-3b5f-4e0a-9c9d-4f6a8b0c2e3a', diagnostics };
      useFeedbackStore.setState({ draft: { ...OLD, diagnostics } });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: { ...NEXT, diagnostics } }).mockResolvedValueOnce({ status: 'enrollment-changed', draft: THIRD });
      render(<FeedbackDialogHost />);
      fireEvent.click(lines());
      await tapSend();
      await tapSend();
      expect(useFeedbackStore.getState().draft?.draftId).toBe(THIRD.draftId);
      expect(lines().checked).toBe(false);
    });

    it('stays off when the box was hidden on the way: the first draft had it, the next has nothing to show', async () => {
      const { correlation: _none, ...noTracing } = NEXT;
      const THIRD = { ...NEXT, draftId: '2d7e8c4a-3b5f-4e0a-9c9d-4f6a8b0c2e3a' };
      useFeedbackStore.setState({ draft: OLD });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: noTracing }).mockResolvedValueOnce({ status: 'enrollment-changed', draft: THIRD });
      render(<FeedbackDialogHost />);
      fireEvent.click(tracing());
      await tapSend();
      expect(screen.queryByRole('checkbox', { name: /Include tracing references/ })).toBeNull();
      await tapSend();
      expect(tracing().checked).toBe(false);
    });
  });

  describe('a reopened draft\'s image', () => {
    const reviewReopened = () => {
      useFeedbackStore.setState({ draft: NEXT, reopened: { notes: 'my note', includeCorrelation: true, includeDiagnostics: true } });
      render(<FeedbackDialogHost />);
    };

    it('goes back with every Send as its own bytes when there are no marks', async () => {
      send.mockRejectedValueOnce(new Error('Local feedback storage is full'));
      reviewReopened();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: NEXT.draftId, includeScreenshot: true, shotId: 's0', annotatedPng: 'bmV3' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ annotatedPng: 'bmV3' }));
    });

    it('isn\'t brought along when the Send leaves it out', async () => {
      reviewReopened();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
      expect(send.mock.lastCall![0]).toMatchObject({ includeScreenshot: false, shotId: 's0', noEdits: true });
      expect(send.mock.lastCall![0]).not.toHaveProperty('annotatedPng');
    });
  });

  describe('a Send that left its image out', () => {
    const LOST = /no longer has its screenshot\. To send one, close this and open a new report\./;
    const NO_IMAGE = { draftId: NEXT.draftId, preview: null, shots: [] };

    it('says the new report lost its screenshot, and doesn\'t claim to have an image', async () => {
      useFeedbackStore.setState({ draft: OLD });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: NO_IMAGE });
      render(<FeedbackDialogHost />);
      fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'my note' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
      expect(screen.getByTestId('feedback-lost-screenshot').textContent).toMatch(LOST);
      expect(screen.getByTestId('feedback-reopened').textContent).toMatch(/with your note\./);
      expect(screen.queryByText('This report has no screenshot.')).toBeNull();
      expect(screen.queryByText(/could be taken/)).toBeNull();
    });

    it('keeps saying so through a second reopen', async () => {
      const THIRD = { ...NO_IMAGE, draftId: '2d7e8c4a-3b5f-4e0a-9c9d-4f6a8b0c2e3a' };
      useFeedbackStore.setState({ draft: OLD });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: NO_IMAGE }).mockResolvedValueOnce({ status: 'enrollment-changed', draft: THIRD });
      render(<FeedbackDialogHost />);
      fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'my note' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
      expect(useFeedbackStore.getState().draft?.draftId).toBe(THIRD.draftId);
      expect(screen.getByTestId('feedback-lost-screenshot').textContent).toMatch(LOST);
    });

    it('a report that never had an image doesn\'t say it lost one', async () => {
      useFeedbackStore.setState({ draft: { draftId: DRAFT.draftId, preview: null, shots: [] } });
      send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: NO_IMAGE });
      render(<FeedbackDialogHost />);
      fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'my note' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
      expect(screen.queryByTestId('feedback-lost-screenshot')).toBeNull();
      expect(screen.getByText('This report has no screenshot.')).toBeTruthy();
      expect(screen.getByTestId('feedback-reopened').textContent).toMatch(/with your note\./);
    });
  });

  it('a later capture starts empty', async () => {
    useFeedbackStore.setState({ draft: OLD });
    send.mockResolvedValueOnce({ status: 'enrollment-changed', draft: NEXT });
    render(<FeedbackDialogHost />);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'my note' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    act(() => { useFeedbackStore.getState().closeDraft(); });
    act(() => { useFeedbackStore.getState().openDraft(DRAFT); });
    expect((screen.getByLabelText('What happened?') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('feedback-reopened')).toBeNull();
  });
});

describe('FeedbackReviewDialog', () => {
  it('reviews the opening correlation summary and lets the user remove it', async () => {
    render(<FeedbackReviewDialog draft={{ ...DRAFT, correlation: { scope: 'incident', capturedAt: '2026-10-24T00:00:00.000Z', traceCount: 2, hostCount: 1, phoneCount: 1, connectionCount: 1 } }} onClose={() => {}} />);
    const choice = screen.getByRole('checkbox', { name: /Include tracing references/ });
    expect((choice as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/2 trace\/span references/)).toBeTruthy();
    fireEvent.click(choice);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeCorrelation: false }));
  });
  describe('diagnostics', () => {
    const line = { at: '2026-11-01T12:00:00.000Z', level: 'warn' as const, ns: 'core:annex', event: 'annex.ws.disconnected', attrs: { closeCode: 1009 } };
    const window = { windowStart: '2026-11-01T11:30:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z' };
    const available = { status: 'available' as const, ...window, lines: [line], bytes: 90, dropped: 2 };

    it('shows every line, the 30-day retention and the chance of loss, and includes them by default', async () => {
      send.mockResolvedValue({ id: 'rep-1', status: 'saved-local', diagnostics: { status: 'queued', lines: 1 } });
      render(<FeedbackReviewDialog draft={{ ...DRAFT, diagnostics: available }} onClose={() => {}} />);
      const box = screen.getByTestId('feedback-diagnostics');
      expect(box.textContent).toMatch(/kept for 30 days, even if the report is deleted/);
      expect(box.textContent).toMatch(/can be lost if Clubhouse quits/);
      expect(box.textContent).toMatch(/Show 1 line \(2 older left out\)/);
      expect(box.textContent).not.toMatch(/\u2014/);
      expect(screen.getByTestId('feedback-diagnostics-lines').textContent).toMatch(/warn core:annex annex\.ws\.disconnected closeCode=1009/);
      expect((screen.getByRole('checkbox', { name: /Include recent diagnostics/ }) as HTMLInputElement).checked).toBe(true);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeDiagnostics: true }));
      expect(screen.getByTestId('feedback-diagnostics-outcome').textContent).toBe('Diagnostics queued to send (1 line).');
    });

    it('says they go with the report when the report carries them', async () => {
      send.mockResolvedValue({ id: 'rep-1', status: 'saved-local', diagnostics: { status: 'attached', lines: 1 } });
      render(<FeedbackReviewDialog draft={{ ...DRAFT, diagnostics: available, diagnosticsInReport: true }} onClose={() => {}} />);
      const box = screen.getByTestId('feedback-diagnostics');
      expect(box.textContent).toMatch(/saved and sent with this report/);
      expect(box.textContent).not.toMatch(/sent separately|kept for 30 days|can be lost/);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(screen.getByTestId('feedback-diagnostics-outcome').textContent).toBe('Diagnostics attached to this report (1 line).');
    });

    it('shows an unavailable report as an error, never as saved, and keeps the review', async () => {
      send.mockRejectedValueOnce(new Error('Feedback needs an enrollment'));
      const onClose = vi.fn();
      render(<FeedbackReviewDialog draft={{ ...DRAFT, diagnostics: available, diagnosticsInReport: true }} onClose={onClose} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(screen.getByRole('alert').textContent).toBe('Feedback needs an enrollment');
      expect(screen.queryByText(/Saved\.|Received\./)).toBeNull();
      expect(screen.queryByTestId('feedback-diagnostics-outcome')).toBeNull();
      expect(screen.getByTestId('feedback-diagnostics-lines')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('lets the reporter leave them out, and says so', async () => {
      send.mockResolvedValue({ id: 'rep-1', status: 'saved-local', diagnostics: { status: 'left_out', reason: 'reporter' } });
      render(<FeedbackReviewDialog draft={{ ...DRAFT, diagnostics: available }} onClose={() => {}} />);
      fireEvent.click(screen.getByRole('checkbox', { name: /Include recent diagnostics/ }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeDiagnostics: false }));
      expect(screen.getByTestId('feedback-diagnostics-outcome').textContent).toBe('Diagnostics left out.');
    });

    it.each([
      ['no_lines', /No recent diagnostics/],
      ['collection_failed', /could not be read/],
    ] as const)('says why there are none (%s), with nothing to toggle', async (reason, text) => {
      render(<FeedbackReviewDialog draft={{ ...DRAFT, diagnostics: { status: 'none', reason, ...window, lines: [], bytes: 0, dropped: 0 } }} onClose={() => {}} />);
      expect(screen.getByTestId('feedback-diagnostics-none').textContent).toMatch(text);
      expect(screen.queryByRole('checkbox', { name: /Include recent diagnostics/ })).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      expect(send.mock.lastCall![0]).not.toHaveProperty('includeDiagnostics');
    });
  });

  it('shows the screenshot and sends it with notes and the scene', async () => {
    const onClose = vi.fn();
    render(<FeedbackReviewDialog draft={DRAFT} onClose={onClose} />);
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(DRAFT.preview);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The agent list froze' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledWith({ draftId: DRAFT.draftId, notes: 'The agent list froze', includeScreenshot: true, scene: 'agents' });
    expect(screen.getByTestId('feedback-sent-state').textContent).toMatch(/^Saved\./);
  });

  describe('what Saved promises', () => {
    const REACHABLE = /^Saved\. It's queued on this computer and is sent as soon as Clubhouse can reach the server\.$/;
    const WAITING = /^Saved\. It's queued on this computer and waits until Clubhouse is connected again\.$/;
    const savedWith = async (status: FeedbackStatus | null) => {
      setFeedback(true, status);
      render(<FeedbackReviewDialog draft={DRAFT} onClose={() => {}} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
      return screen.getByTestId('feedback-sent-state').textContent;
    };

    it.each(['connected', 'offline', 'checking', 'stopped'] as const)('%s: sent once the server can be reached', async (state) => {
      expect(await savedWith(feedbackStatus({ state, connected: state === 'connected' }))).toMatch(REACHABLE);
    });

    it('migration-required notice: waits for a connection', async () => {
      expect(await savedWith(feedbackStatus({ state: 'migration-required', connected: false, notice: 'migration-required' }))).toMatch(WAITING);
    });

    it.each([
      ['expired', 'Connect with a new invitation'],
      ['access-required', 'Connect with a new invitation'],
      ['connection-uncertain', 'Connect again'],
    ] as const)('%s notice: says a connection and a Send are both needed', async (notice, connect) => {
      const text = await savedWith(feedbackStatus({ state: notice, connected: false, notice }));
      expect(text).toBe(`Saved on this computer, but it can't be sent yet. ${connect} in Settings, Feedback, then send it from there.`);
      expect(text).not.toMatch(/as soon as|waits until/);
    });

    it('offline keeps its promise, because the same connection comes back', async () => {
      expect(await savedWith(feedbackStatus({ state: 'offline', connected: false, notice: null }))).toMatch(REACHABLE);
    });

    it.each(['disconnected', 'disconnecting', 'connecting', 'storage-unavailable'] as const)('%s: waits for a connection', async (state) => {
      expect(await savedWith(feedbackStatus({ state, connected: false }))).toMatch(WAITING);
    });

    it('a rejected connection: says a new connection and a Send are both needed, and promises no delivery', async () => {
      const text = await savedWith(feedbackStatus({ state: 'enrollment-response-rejected', connected: false, notice: 'enrollment-response-rejected', expiresAt: null }));
      expect(text).toBe('Saved on this computer, but it can\'t be sent yet. Connect with a new invitation in Settings, Feedback, then send it from there.');
      expect(text).not.toMatch(/Framebriar|as soon as|waits until|—/);
    });

    it('a notice wins over a state that could otherwise deliver', async () => {
      expect(await savedWith(feedbackStatus({ state: 'checking', connected: false, notice: 'migration-required' }))).toMatch(WAITING);
    });

    it('with no status yet, keeps the plain promise', async () => {
      expect(await savedWith(null)).toMatch(REACHABLE);
    });

    it('follows the access state while the sheet stays open', async () => {
      expect(await savedWith(feedbackStatus())).toMatch(REACHABLE);
      act(() => { useFeedbackStore.setState({ status: feedbackStatus({ state: 'expired', connected: false, notice: 'expired' }) }); });
      expect(screen.getByTestId('feedback-sent-state').textContent).toMatch(/then send it from there\.$/);
    });
  });

  it('shows a send failure without the prefix Electron adds across IPC', async () => {
    send.mockRejectedValueOnce(new Error("Error invoking remote method 'feedback:send': Error: Feedback needs an enrollment"));
    render(<FeedbackReviewDialog draft={DRAFT} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByRole('alert').textContent).toBe('Feedback needs an enrollment');
    expect(screen.queryByTestId('feedback-sent-state')).toBeNull();
  });

  it('switches from Saved to Received when the server acknowledges the report', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByTestId('feedback-sent-state').textContent).toMatch(/^Saved/);
    act(() => { useFeedbackStore.setState({ status: feedbackStatus({ received: ['rep-1'] }) }); });
    expect(screen.getByTestId('feedback-sent-state').textContent).toMatch(/^Received/);
  });

  it('sends without the screenshot only with a note', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={() => {}} />);
    const textOnly = screen.getByRole('button', { name: 'Send without screenshot' });
    expect(textOnly.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'no picture please' } });
    await act(async () => { fireEvent.click(textOnly); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: false, notes: 'no picture please' }));
  });

  it('without a screenshot, Send needs a note and goes text-only', async () => {
    render(<FeedbackReviewDialog draft={{ ...DRAFT, preview: null }} onClose={() => {}} />);
    expect(screen.queryByTestId('feedback-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'hi' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: false }));
  });

  it('Cancel drops the draft and closes', () => {
    const onClose = vi.fn();
    render(<FeedbackReviewDialog draft={DRAFT} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledWith(DRAFT.draftId);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the review open with the error when saving fails', async () => {
    send.mockRejectedValueOnce(new Error('Local feedback storage is full'));
    render(<FeedbackReviewDialog draft={DRAFT} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByRole('alert').textContent).toBe('Local feedback storage is full');
    expect(screen.getByTestId('feedback-preview')).toBeTruthy();
  });
});

describe('FeedbackReviewDialog drawing (#2099)', () => {
  const composite = vi.mocked(compositeAnnotatedPng);

  beforeEach(() => {
    composite.mockReset().mockResolvedValue('ANNOTATED');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => vi.restoreAllMocks());

  function drawOnce() {
    const img = screen.getByTestId('feedback-preview');
    Object.defineProperty(img, 'naturalWidth', { value: 200, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 200, configurable: true });
    fireEvent.load(img);
    const canvas = screen.getByTestId('feedback-ink-canvas');
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  }

  it('sends the screenshot with the drawing baked in', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    drawOnce();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(composite).toHaveBeenCalledWith(DRAFT.preview, [expect.objectContaining({ points: [{ x: 20, y: 20 }] })]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: true, annotatedPng: 'ANNOTATED' }));
  });

  it('sends the plain capture when nothing was drawn', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(composite).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).not.toHaveProperty('annotatedPng');
  });

  it('brings a drawing along with text-only feedback, since those edits are final too', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    drawOnce();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'words only' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(composite).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ includeScreenshot: false, annotatedPng: 'ANNOTATED' }));
    expect(send.mock.calls[0][0]).not.toHaveProperty('noEdits');
  });

  it('starts a new capture without the previous drawing', () => {
    const { rerender } = render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    drawOnce();
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeEnabled();
    rerender(<FeedbackReviewDialog draft={{ ...DRAFT, draftId: '1c6d7b3f-2a4e-4d9f-8b8c-3e5f7a9b1d2f' }} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeDisabled();
  });

  it('shows an error and keeps the review open when the drawing cannot be saved', async () => {
    composite.mockRejectedValueOnce(new Error("Couldn't save the screenshot with your drawing"));
    render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    drawOnce();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('feedback-error')).toHaveTextContent("Couldn't save the screenshot with your drawing");
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeEnabled();
  });
});

describe('FeedbackReviewDialog with several windows (#2100)', () => {
  const composite = vi.mocked(compositeAnnotatedPng);
  const MULTI = {
    draftId: '2d7e8c4a-3b5f-4ea0-9c9d-4f6a8b0c2e3a',
    preview: 'data:image/png;base64,TUFJTg==',
    shots: [
      { shotId: 's0', label: 'Main window', preview: 'data:image/png;base64,TUFJTg==' },
      { shotId: 's1', label: 'Agent: faithful-urchin', preview: 'data:image/png;base64,UE9QT1VU' },
    ],
  };

  beforeEach(() => {
    composite.mockReset().mockResolvedValue('ANNOTATED');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => vi.restoreAllMocks());

  function drawOnce() {
    const img = screen.getByTestId('feedback-preview');
    Object.defineProperty(img, 'naturalWidth', { value: 200, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 200, configurable: true });
    fireEvent.load(img);
    const canvas = screen.getByTestId('feedback-ink-canvas');
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  }

  it('lists each window, starting with the one feedback came from', () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Main window', 'Agent: faithful-urchin']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(MULTI.shots[0].preview);
  });

  it('fixes the window once a Send has been tried, even if it failed', async () => {
    send.mockRejectedValueOnce(new Error('Local feedback storage is full'));
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    const other = screen.getByRole('radio', { name: /faithful-urchin/ });
    expect(other).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByRole('alert').textContent).toMatch(/full/);
    expect(other).toBeDisabled();
    fireEvent.click(other);
    fireEvent.keyDown(screen.getByTestId('feedback-shots'), { key: 'ArrowRight' });
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(MULTI.shots[0].preview);
  });

  it('a Send that leaves the image out says which window, and that it has no edits', async () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /faithful-urchin/ }));
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'no picture' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: false, shotId: 's1', noEdits: true }));
  });

  it('a Send that leaves the image out brings the flattened image when this window has marks, and never says no edits', async () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    drawOnce();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'no picture' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: false, shotId: 's0', annotatedPng: 'ANNOTATED' }));
    expect(send.mock.lastCall![0]).not.toHaveProperty('noEdits');
  });

  it.each([
    ['s0', 's1', /faithful-urchin/, /Main window/],
    ['s1', 's0', /Main window/, /faithful-urchin/],
  ])('marks on %s with unmarked %s selected: no edits, for the selected window only', async (marked, selected, select, start) => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: start }));
    drawOnce();
    fireEvent.click(screen.getByRole('radio', { name: select }));
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'no picture' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(marked).not.toBe(selected);
    expect(composite).not.toHaveBeenCalled();
    expect(send.mock.lastCall![0]).toMatchObject({ includeScreenshot: false, shotId: selected, noEdits: true });
    expect(send.mock.lastCall![0]).not.toHaveProperty('annotatedPng');
  });

  it('a composite that fails can\'t stop a Send that leaves the image out, and it doesn\'t claim no edits', async () => {
    composite.mockRejectedValueOnce(new Error('canvas broke'));
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    drawOnce();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'no picture' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall![0]).not.toHaveProperty('annotatedPng');
    expect(send.mock.lastCall![0]).not.toHaveProperty('noEdits');
    expect(screen.getByTestId('feedback-sent-state')).toBeTruthy();
  });

  it('a composite that fails does stop a Send with the image', async () => {
    composite.mockRejectedValueOnce(new Error('canvas broke'));
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    drawOnce();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/canvas broke/);
  });

  it('a Send with the image never says no edits', async () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send.mock.lastCall![0]).not.toHaveProperty('noEdits');
  });

  it('sends the chosen window', async () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /faithful-urchin/ }));
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(MULTI.shots[1].preview);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: true, shotId: 's1' }));
  });

  it("keeps each window's ink and bakes the chosen window's", async () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    drawOnce();
    fireEvent.click(screen.getByRole('radio', { name: /faithful-urchin/ }));
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Main window' }));
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(composite).toHaveBeenCalledWith(MULTI.shots[0].preview, [expect.anything()]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ shotId: 's0', annotatedPng: 'ANNOTATED' }));
  });

  it('shows no picker for a single window, and a text-only send still names it', async () => {
    render(<FeedbackReviewDialog draft={{ ...MULTI, shots: [MULTI.shots[0]] }} onClose={vi.fn()} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'text' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(send.mock.calls[0][0]).toMatchObject({ includeScreenshot: false, shotId: 's0', noEdits: true });
  });

  it('moves between windows with the arrow keys, one Tab stop for the group', () => {
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0]);
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' });
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('locks the window choice while sending', async () => {
    let resolveSend: (v: unknown) => void = () => {};
    send.mockReturnValueOnce(new Promise((r) => { resolveSend = r; }));
    render(<FeedbackReviewDialog draft={MULTI} onClose={vi.fn()} />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    await act(async () => {});
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    await act(async () => { resolveSend({ id: 'rep-1', status: 'saved-local' }); });
  });
});
