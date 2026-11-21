import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionLineContent } from './ActionListPresentation';
import { formatWhen } from './ActionOutcome';
it('never formats invalid Date-domain times as Invalid Date', () => {
  expect(formatWhen(Number.MAX_SAFE_INTEGER)).toBe('Time unavailable');
  render(<ActionLineContent name="Reminder" enabled description="Wake Selected" lastRun={{ outcome: 'done', startedAt: Number.MAX_SAFE_INTEGER }} />);
  expect(screen.getByText(/Time unavailable/)).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('Invalid Date');
  expect(formatWhen(0)).not.toContain('Invalid Date');
});
