import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionBanner } from './PermissionBanner';
import type { PermissionRequest } from '../../../../shared/structured-events';

const request: PermissionRequest = {
  id: 'perm-1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf node_modules && npm install' },
  description: 'Execute a shell command',
};

describe('PermissionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the tool name and command', () => {
    render(<PermissionBanner request={request} onRespond={vi.fn()} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('rm -rf node_modules && npm install')).toBeInTheDocument();
  });

  it('renders the description', () => {
    render(<PermissionBanner request={request} onRespond={vi.fn()} />);
    expect(screen.getByText('Execute a shell command')).toBeInTheDocument();
  });

  it('shows the countdown timer starting at 120s', () => {
    render(<PermissionBanner request={request} onRespond={vi.fn()} />);
    expect(screen.getByText('120s')).toBeInTheDocument();
  });

  it('counts down every second', () => {
    render(<PermissionBanner request={request} onRespond={vi.fn()} />);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('115s')).toBeInTheDocument();
  });

  it('calls onRespond(id, true) when Approve is clicked', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByTestId('permission-approve'));
    expect(onRespond).toHaveBeenCalledWith('perm-1', true);
  });

  it('calls onRespond(id, false) when Deny is clicked', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByTestId('permission-deny'));
    expect(onRespond).toHaveBeenCalledWith('perm-1', false);
  });

  it('auto-denies when countdown reaches 0', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner request={request} onRespond={onRespond} />);

    act(() => { vi.advanceTimersByTime(120_000); });
    expect(onRespond).toHaveBeenCalledWith('perm-1', false);
  });

  it('only responds once even if both clicked', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByTestId('permission-approve'));
    fireEvent.click(screen.getByTestId('permission-deny'));
    expect(onRespond).toHaveBeenCalledTimes(1);
  });
});
