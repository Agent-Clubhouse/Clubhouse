import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeBanner } from './ResumeBanner';

describe('ResumeBanner', () => {
  it('renders nothing when no sessions', () => {
    const { container } = render(<ResumeBanner sessions={[]} onManualResume={vi.fn()} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders session count and statuses', () => {
    render(
      <ResumeBanner
        sessions={[
          { agentId: 'a', agentName: 'darling-gazelle', status: 'resumed' },
          { agentId: 'b', agentName: 'mega-camel', status: 'resuming' },
          { agentId: 'c', agentName: 'zesty-lynx', status: 'manual' },
        ]}
        onManualResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/resuming 3 sessions/i)).toBeDefined();
    expect(screen.getByText('darling-gazelle')).toBeDefined();
    expect(screen.getByText(/Resume/)).toBeDefined();
  });

  it('calls onManualResume when tap to resume clicked', () => {
    const onManualResume = vi.fn();
    render(
      <ResumeBanner
        sessions={[{ agentId: 'c', agentName: 'zesty-lynx', status: 'manual' }]}
        onManualResume={onManualResume}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/Resume/));
    expect(onManualResume).toHaveBeenCalledWith('c');
  });

  it('calls onDismiss when dismiss clicked', () => {
    const onDismiss = vi.fn();
    render(
      <ResumeBanner
        sessions={[{ agentId: 'a', agentName: 'test', status: 'resumed' }]}
        onManualResume={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('ResumeBanner card variant (new chrome)', () => {
  it('lists sessions with a dot and one status word, and resumes manual ones', () => {
    const onManualResume = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ResumeBanner
        variant="card"
        sessions={[
          { agentId: 'a', agentName: 'darling-gazelle', status: 'resumed' },
          { agentId: 'b', agentName: 'mega-camel', status: 'failed', error: 'No session' },
          { agentId: 'c', agentName: 'zesty-lynx', status: 'manual' },
        ]}
        onManualResume={onManualResume}
        onDismiss={onDismiss}
      />,
    );
    const card = screen.getByTestId('resume-banner');
    expect(card).toHaveTextContent('Resuming 3 sessions');
    expect(card).toHaveTextContent('Done');
    expect(card).toHaveTextContent('Error');
    expect(card).toHaveTextContent('No session');
    expect(card).toHaveTextContent('Needs you');
    expect(card.textContent).not.toMatch(/[✓↻○▸✗⏱]/);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onManualResume).toHaveBeenCalledWith('c');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

