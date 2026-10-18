import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { useUIStore } from '../../stores/uiStore';
import { FeedbackReviewDialog } from './FeedbackReviewDialog';
import { feedbackStatus, setFeedback } from './feedback-test-utils';
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

describe('FeedbackReviewDialog', () => {
  it('shows the screenshot and sends it with notes and the scene', async () => {
    const onClose = vi.fn();
    render(<FeedbackReviewDialog draft={DRAFT} onClose={onClose} />);
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(DRAFT.preview);
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The agent list froze' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(send).toHaveBeenCalledWith({ draftId: DRAFT.draftId, notes: 'The agent list froze', includeScreenshot: true, scene: 'agents' });
    expect(screen.getByTestId('feedback-sent-state').textContent).toMatch(/^Saved\./);
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

  it('leaves text-only feedback unaffected by a drawing', async () => {
    render(<FeedbackReviewDialog draft={DRAFT} onClose={vi.fn()} />);
    drawOnce();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'words only' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(composite).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ includeScreenshot: false }));
    expect(send.mock.calls[0][0]).not.toHaveProperty('annotatedPng');
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

  it('shows no picker for a single window, and no shotId on a text-only send', async () => {
    render(<FeedbackReviewDialog draft={{ ...MULTI, shots: [MULTI.shots[0]] }} onClose={vi.fn()} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'text' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without screenshot' })); });
    expect(send.mock.calls[0][0]).not.toHaveProperty('shotId');
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
