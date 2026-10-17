import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { useUIStore } from '../../stores/uiStore';
import { FeedbackReviewDialog } from './FeedbackReviewDialog';
import { feedbackStatus, setFeedback } from './feedback-test-utils';

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
