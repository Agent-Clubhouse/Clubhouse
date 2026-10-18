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
