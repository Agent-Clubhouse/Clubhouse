import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';

vi.mock('../../features/agents/DeleteAgentDialog', () => ({ DeleteAgentDialog: () => <div data-testid="delete-dialog" /> }));
vi.mock('../../features/agents/helpers/HelperDisposeRequestDialog', () => ({ HelperDisposeRequestDialog: () => <div data-testid="dispose-dialog" /> }));
vi.mock('../../features/managed/restart', () => ({ ManagedRestartHost: () => <div data-testid="restart-host" /> }));

import { ChromeAgentDialogs } from './ChromeAgentDialogs';
import { useAgentStore } from '../../stores/agentStore';

describe('ChromeAgentDialogs', () => {
  it('hosts the delete dialog while an agent is being deleted, and the always-mounted hosts', () => {
    useAgentStore.setState({ deleteDialogAgent: null });
    render(<ChromeAgentDialogs />);
    expect(screen.queryByTestId('delete-dialog')).toBeNull();
    expect(screen.getByTestId('restart-host')).toBeTruthy();
    expect(screen.getByTestId('dispose-dialog')).toBeTruthy();

    act(() => useAgentStore.setState({ deleteDialogAgent: 'a1' }));
    expect(screen.getByTestId('delete-dialog')).toBeTruthy();
  });
});
