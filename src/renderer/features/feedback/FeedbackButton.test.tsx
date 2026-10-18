import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore } from '../../stores/feedbackStore';
import { useToastStore } from '../../stores/toastStore';
import { FeedbackButton } from './FeedbackButton';
import { FeedbackDialogHost } from './FeedbackDialogHost';
import { feedbackStatus, setFeedback } from './feedback-test-utils';

const PREVIEW = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  window.clubhouse.feedback.capture = vi.fn(async () => ({ draftId: '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e', preview: PREVIEW, shots: [] }));
  window.clubhouse.feedback.send = vi.fn(async () => ({ id: 'rep-1', status: 'saved-local' as const }));
  window.clubhouse.feedback.cancel = vi.fn(async () => {});
  useToastStore.setState({ toasts: [] });
});
afterEach(() => resetFeedbackStore());

describe('FeedbackButton', () => {
  it('renders nothing unless the switch is on and capture is allowed', () => {
    setFeedback(false);
    const { rerender } = render(<FeedbackButton variant="sidebar" />);
    expect(screen.queryByTestId('nav-feedback')).toBeNull();
    setFeedback(true, feedbackStatus({ canCapture: false }));
    rerender(<FeedbackButton variant="sidebar" />);
    expect(screen.queryByTestId('nav-feedback')).toBeNull();
    setFeedback(true);
    rerender(<FeedbackButton variant="sidebar" />);
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
  });

  it('keeps a marker and explanation while a notice or unsent feedback is pending', () => {
    setFeedback(true, feedbackStatus({ notice: 'expired', outbox: { ...feedbackStatus().outbox, pending: 2 } }));
    render(<FeedbackButton variant="rail" expanded />);
    expect(screen.getByTestId('feedback-marker').getAttribute('data-kind')).toBe('notice');
    const button = screen.getByTestId('nav-feedback');
    expect(button.getAttribute('title')).toMatch(/expired.*2 feedback reports waiting to send/);
    expect(button.textContent).toContain('Feedback');
  });

  it('captures first, then opens the review dialog with the preview', async () => {
    setFeedback(true);
    render(<><FeedbackButton variant="sidebar" /><FeedbackDialogHost /></>);
    fireEvent.click(screen.getByTestId('nav-feedback'));
    expect(await screen.findByTestId('feedback-review')).toBeTruthy();
    expect(window.clubhouse.feedback.capture).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(PREVIEW);
  });

  it('keeps an open review when capture eligibility flips mid-review', async () => {
    setFeedback(true);
    render(<><FeedbackButton variant="sidebar" /><FeedbackDialogHost /></>);
    fireEvent.click(screen.getByTestId('nav-feedback'));
    await screen.findByTestId('feedback-review');
    act(() => { useFeedbackStore.setState({ status: feedbackStatus({ canCapture: false, notice: 'expired' }) }); });
    expect(screen.queryByTestId('nav-feedback')).toBeNull();
    expect(screen.getByTestId('feedback-review')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'still here' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(window.clubhouse.feedback.send).toHaveBeenCalledWith(expect.objectContaining({ notes: 'still here', includeScreenshot: true }));
  });

  it('tells the user when capture fails', async () => {
    setFeedback(true);
    window.clubhouse.feedback.capture = vi.fn(async () => { throw new Error('Feedback needs an enrollment'); });
    render(<><FeedbackButton variant="sidebar" /><FeedbackDialogHost /></>);
    await act(async () => { fireEvent.click(screen.getByTestId('nav-feedback')); });
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Couldn't capture feedback: Feedback needs an enrollment"));
    expect(screen.queryByTestId('feedback-review')).toBeNull();
  });

  it('cancels a review that is replaced by a new capture', () => {
    setFeedback(true);
    render(<FeedbackDialogHost />);
    act(() => useFeedbackStore.getState().openDraft({ draftId: '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e', preview: PREVIEW, shots: [] }));
    act(() => useFeedbackStore.getState().openDraft({ draftId: '1c6d7b3f-2a4e-4d9f-8b8c-3e5f7a9b1d2f', preview: PREVIEW, shots: [] }));
    expect(window.clubhouse.feedback.cancel).toHaveBeenCalledWith('0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e');
    expect(screen.getAllByTestId('feedback-review')).toHaveLength(1);
  });
});
