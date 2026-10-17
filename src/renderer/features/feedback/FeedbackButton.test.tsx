import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore } from '../../stores/feedbackStore';
import { useToastStore } from '../../stores/toastStore';
import { FeedbackButton } from './FeedbackButton';
import { feedbackStatus, setFeedback } from './feedback-test-utils';

const PREVIEW = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  window.clubhouse.feedback.capture = vi.fn(async () => ({ draftId: '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e', preview: PREVIEW }));
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
    render(<FeedbackButton variant="sidebar" />);
    fireEvent.click(screen.getByTestId('nav-feedback'));
    expect(await screen.findByTestId('feedback-review')).toBeTruthy();
    expect(window.clubhouse.feedback.capture).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('feedback-preview').getAttribute('src')).toBe(PREVIEW);
  });

  it('tells the user when capture fails', async () => {
    setFeedback(true);
    window.clubhouse.feedback.capture = vi.fn(async () => { throw new Error('Feedback needs an enrollment'); });
    render(<FeedbackButton variant="sidebar" />);
    await act(async () => { fireEvent.click(screen.getByTestId('nav-feedback')); });
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("Couldn't capture feedback: Feedback needs an enrollment"));
    expect(screen.queryByTestId('feedback-review')).toBeNull();
  });
});
