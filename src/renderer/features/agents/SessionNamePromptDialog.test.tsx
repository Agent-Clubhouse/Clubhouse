import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionNamePromptDialog } from './SessionNamePromptDialog';

describe('SessionNamePromptDialog', () => {
  const onDone = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue({
      id: 'agent-1',
      lastSessionId: 'sess-abc-123',
    });
    window.clubhouse.agent.updateSessionName = vi.fn().mockResolvedValue(undefined);
  });

  function renderDialog() {
    return render(
      <SessionNamePromptDialog
        agentId="agent-1"
        projectPath="/projects/test"
        onDone={onDone}
      />
    );
  }

  it('renders the dialog', () => {
    renderDialog();
    expect(screen.getByTestId('session-name-prompt-dialog')).toBeInTheDocument();
    expect(screen.getByText('Name This Session')).toBeInTheDocument();
  });

  it('renders into document.body via portal, not inside parent container', () => {
    const { container } = renderDialog();
    expect(screen.getByTestId('session-name-prompt-dialog')).toBeInTheDocument();
    // Dialog should NOT be inside the render container (it's portaled to document.body)
    expect(container.querySelector('[data-testid="session-name-prompt-dialog"]')).toBeNull();
    // But it should be in document.body
    expect(document.body.querySelector('[data-testid="session-name-prompt-dialog"]')).not.toBeNull();
  });

  it('has a text input for the name', () => {
    renderDialog();
    expect(screen.getByTestId('session-name-input')).toBeInTheDocument();
  });

  it('calls onDone when skip is clicked', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('session-name-skip'));
    expect(onDone).toHaveBeenCalled();
  });

  it('saves the session name and calls onDone when save is clicked', async () => {
    renderDialog();

    // Wait for config to load
    await waitFor(() => {
      expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalledWith('/projects/test', 'agent-1');
    });

    const input = screen.getByTestId('session-name-input');
    fireEvent.change(input, { target: { value: 'My Bug Fix' } });
    fireEvent.click(screen.getByTestId('session-name-save'));

    await waitFor(() => {
      expect(window.clubhouse.agent.updateSessionName).toHaveBeenCalledWith(
        '/projects/test',
        'agent-1',
        'sess-abc-123',
        'My Bug Fix',
      );
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('calls onDone without saving when name is empty and save is clicked', async () => {
    renderDialog();
    await waitFor(() => {
      expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalled();
    });

    // Save button should be disabled when empty
    const saveBtn = screen.getByTestId('session-name-save');
    expect(saveBtn).toBeDisabled();
  });

  it('saves on Enter key press', async () => {
    renderDialog();
    await waitFor(() => {
      expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalled();
    });

    const input = screen.getByTestId('session-name-input');
    fireEvent.change(input, { target: { value: 'Feature Work' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(window.clubhouse.agent.updateSessionName).toHaveBeenCalledWith(
        '/projects/test',
        'agent-1',
        'sess-abc-123',
        'Feature Work',
      );
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('skips on Escape key press', () => {
    renderDialog();
    const input = screen.getByTestId('session-name-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
  });

  it('handles missing lastSessionId gracefully', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue({
      id: 'agent-1',
      lastSessionId: undefined,
    });

    renderDialog();
    await waitFor(() => {
      expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalled();
    });

    const input = screen.getByTestId('session-name-input');
    fireEvent.change(input, { target: { value: 'Test Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Should call onDone without trying to save (no session ID)
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(window.clubhouse.agent.updateSessionName).not.toHaveBeenCalled();
  });
});
