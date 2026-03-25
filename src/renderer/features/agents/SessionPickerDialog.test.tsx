import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionPickerDialog } from './SessionPickerDialog';

const mockSessions = [
  { sessionId: 'aaa-bbb-ccc-111', startedAt: '2024-06-15T10:00:00Z', lastActiveAt: '2024-06-15T12:00:00Z', friendlyName: 'Feature Work' },
  { sessionId: 'ddd-eee-fff-222', startedAt: '2024-06-14T08:00:00Z', lastActiveAt: '2024-06-14T09:00:00Z' },
  { sessionId: 'ggg-hhh-iii-333', startedAt: '2024-06-10T08:00:00Z', lastActiveAt: '2024-06-10T09:00:00Z', friendlyName: 'Bug Fix' },
];

describe('SessionPickerDialog', () => {
  const onResume = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agent.listSessions = vi.fn().mockResolvedValue(mockSessions);
    window.clubhouse.agent.updateSessionName = vi.fn().mockResolvedValue(undefined);
  });

  function renderDialog() {
    return render(
      <SessionPickerDialog
        agentId="agent-1"
        projectPath="/projects/test"
        orchestrator="claude-code"
        onResume={onResume}
        onClose={onClose}
      />
    );
  }

  it('renders dialog', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    renderDialog();
    expect(screen.getByText('Loading sessions...')).toBeInTheDocument();
  });

  it('loads and displays sessions', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('Feature Work')).toBeInTheDocument();
    });
    // Session without name shows truncated ID
    expect(screen.getByText(/Session ddd-eee-/)).toBeInTheDocument();
    expect(screen.getByText('Bug Fix')).toBeInTheDocument();
  });

  it('shows latest badge on first session', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('latest')).toBeInTheDocument();
    });
  });

  it('calls listSessions with correct params', async () => {
    renderDialog();
    await waitFor(() => {
      expect(window.clubhouse.agent.listSessions).toHaveBeenCalledWith(
        '/projects/test',
        'agent-1',
        'claude-code'
      );
    });
  });

  it('calls onResume when resume button is clicked', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('resume-session-0')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('resume-session-0'));
    expect(onResume).toHaveBeenCalledWith('aaa-bbb-ccc-111');
  });

  it('calls onClose when close button is clicked', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows empty state when no sessions found', async () => {
    window.clubhouse.agent.listSessions = vi.fn().mockResolvedValue([]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('No sessions found')).toBeInTheDocument();
    });
  });

  it('allows manual session ID entry', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Or enter a session ID...')).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Or enter a session ID...');
    fireEvent.change(input, { target: { value: 'manual-sess-id' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResume).toHaveBeenCalledWith('manual-sess-id');
  });

  it('renders into document.body via portal, not inside parent container', async () => {
    const { container } = renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId('session-picker-dialog')).toBeInTheDocument();
    });
    // Dialog should NOT be inside the render container (it's portaled to document.body)
    expect(container.querySelector('[data-testid="session-picker-dialog"]')).toBeNull();
    // But it should be in document.body
    expect(document.body.querySelector('[data-testid="session-picker-dialog"]')).not.toBeNull();
  });

  describe('Recent / Older sections', () => {
    it('shows "Recent" label when sessions exist', async () => {
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Recent')).toBeInTheDocument();
      });
    });

    it('does not show "Older" label when sessions <= 5', async () => {
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Feature Work')).toBeInTheDocument();
      });
      expect(screen.queryByText('Older')).toBeNull();
    });

    it('shows "Older" label when sessions > 5', async () => {
      const manySessions = Array.from({ length: 7 }, (_, i) => ({
        sessionId: `sess-${i}`,
        startedAt: `2024-06-${15 - i}T10:00:00Z`,
        lastActiveAt: `2024-06-${15 - i}T12:00:00Z`,
        friendlyName: `Session ${i}`,
      }));
      window.clubhouse.agent.listSessions = vi.fn().mockResolvedValue(manySessions);

      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('Recent')).toBeInTheDocument();
        expect(screen.getByText('Older')).toBeInTheDocument();
      });

      // First 5 should be in Recent, last 2 in Older
      expect(screen.getByTestId('session-entry-0')).toBeInTheDocument();
      expect(screen.getByTestId('session-entry-4')).toBeInTheDocument();
      expect(screen.getByTestId('session-entry-5')).toBeInTheDocument();
      expect(screen.getByTestId('session-entry-6')).toBeInTheDocument();
    });

    it('does not show section labels when no sessions', async () => {
      window.clubhouse.agent.listSessions = vi.fn().mockResolvedValue([]);
      renderDialog();
      await waitFor(() => {
        expect(screen.getByText('No sessions found')).toBeInTheDocument();
      });
      expect(screen.queryByText('Recent')).toBeNull();
      expect(screen.queryByText('Older')).toBeNull();
    });
  });
});
