import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MainPanel, activate, deactivate } from './main';
import { createMockAPI, createMockContext } from '../../testing';

function createTerminalAPI(bufferContent = '') {
  const onExitHandlers: ((code: number) => void)[] = [];

  return createMockAPI({
    terminal: {
      spawn: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {}),
      getBuffer: vi.fn(async () => bufferContent),
      onData: () => ({ dispose: () => {} }),
      onExit: vi.fn((_sessionId: string, cb: (code: number) => void) => {
        onExitHandlers.push(cb);
        return { dispose: () => {} };
      }),
      ShellTerminal: ({ sessionId }: { sessionId: string }) =>
        React.createElement('div', { 'data-testid': 'shell-terminal' }, `Shell: ${sessionId}`),
    },
    context: {
      mode: 'project',
      projectId: 'proj-1',
      projectPath: '/project',
    },
    _onExitHandlers: onExitHandlers,
  } as any);
}

describe('Terminal MainPanel', () => {
  it('shows "Starting..." before spawn completes', () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByText('Starting terminal...')).toBeInTheDocument();
    expect(screen.getByText('Starting...')).toBeInTheDocument();
  });

  it('shows "Running" + ShellTerminal after spawn', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
    });
  });

  it('shows "Exited (code)" on exit', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    // Wait for terminal to be running
    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
    });

    // Trigger exit via the onExit handler
    const onExitHandlers = (api as any)._onExitHandlers;
    act(() => {
      for (const handler of onExitHandlers) {
        handler(137);
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Exited (137)')).toBeInTheDocument();
    });
  });

  it('restart calls kill then re-spawn', async () => {
    const api = createTerminalAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId('shell-terminal')).toBeInTheDocument();
    });

    const restartBtn = screen.getByText('Restart');
    fireEvent.click(restartBtn);

    await waitFor(() => {
      expect(api.terminal.kill).toHaveBeenCalledWith('proj-1');
      expect(api.terminal.spawn).toHaveBeenCalledTimes(2); // initial + restart
    });
  });
});

describe('Terminal activate/deactivate', () => {
  it('activate registers the restart command', () => {
    const ctx = createMockContext();
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('restart', expect.any(Function));
    expect(ctx.subscriptions).toHaveLength(1);
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
