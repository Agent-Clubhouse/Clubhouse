import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  DurablePermissionPrompt,
  explainRejection,
  secondsRemaining,
  primaryInput,
} from './DurablePermissionPrompt';
import { usePendingPermissionStore } from '../../stores/pendingPermissionStore';
import type { PendingPermissionInfo } from '../../../shared/permission-types';

function makePermission(overrides?: Partial<PendingPermissionInfo>): PendingPermissionInfo {
  return {
    requestId: 'req-1',
    agentId: 'agent-1',
    toolName: 'Skill',
    createdAt: Date.now(),
    timeoutMs: 110_000,
    ...overrides,
  };
}

describe('DurablePermissionPrompt helpers', () => {
  it('secondsRemaining counts down and floors at zero', () => {
    const p = makePermission({ createdAt: 1_000, timeoutMs: 10_000 });
    expect(secondsRemaining(p, 1_000)).toBe(10);
    expect(secondsRemaining(p, 6_000)).toBe(5);
    expect(secondsRemaining(p, 99_000)).toBe(0);
  });

  it('primaryInput prefers the most descriptive field', () => {
    expect(primaryInput(makePermission({ toolInput: { command: 'rm -rf /' } }))).toBe('rm -rf /');
    expect(primaryInput(makePermission({ toolInput: { file_path: '/etc/hosts' } }))).toBe('/etc/hosts');
    expect(primaryInput(makePermission({ toolInput: { skill: 'deploy' } }))).toBe('deploy');
    expect(primaryInput(makePermission({ toolInput: { question: 'Ship it?' } }))).toBe('Ship it?');
    expect(primaryInput(makePermission({ toolInput: { other: 1 } }))).toContain('"other": 1');
    expect(primaryInput(makePermission({ toolInput: {} }))).toBeNull();
    expect(primaryInput(makePermission())).toBeNull();
  });

  it('explainRejection covers every rejection reason', () => {
    for (const reason of ['expired', 'not_found', 'agent_mismatch', 'unknown_agent', 'invalid_decision'] as const) {
      expect(explainRejection(reason)).toBeTruthy();
    }
  });
});

describe('DurablePermissionPrompt', () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    usePendingPermissionStore.setState({ byRequestId: {} });
    resolveSpy = vi.spyOn(window.clubhouse.agent, 'resolvePendingPermission');
    resolveSpy.mockResolvedValue({ status: 'resolved' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(permission: PendingPermissionInfo): void {
    usePendingPermissionStore.getState().addPending(permission);
  }

  it('renders nothing when the agent has no pending request', () => {
    render(<DurablePermissionPrompt agentId="agent-1" />);
    expect(screen.queryByTestId('durable-permission-prompt')).toBeNull();
  });

  it('ignores requests belonging to other agents', () => {
    seed(makePermission({ agentId: 'agent-2' }));
    render(<DurablePermissionPrompt agentId="agent-1" />);
    expect(screen.queryByTestId('durable-permission-prompt')).toBeNull();
  });

  it('shows the tool, input and countdown for a pending request', () => {
    seed(makePermission({ toolName: 'Skill', toolInput: { skill: 'deploy' }, message: 'Run deploy?' }));

    render(<DurablePermissionPrompt agentId="agent-1" />);

    expect(screen.getByTestId('durable-permission-prompt')).toBeTruthy();
    expect(screen.getByText('Skill')).toBeTruthy();
    expect(screen.getByText('deploy')).toBeTruthy();
    expect(screen.getByText('Run deploy?')).toBeTruthy();
    expect(screen.getByTestId('permission-countdown').textContent).toMatch(/^\d+s$/);
  });

  it('sends allow when Approve is clicked', async () => {
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);

    fireEvent.click(screen.getByTestId('durable-permission-approve'));

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('agent-1', 'req-1', 'allow');
    });
    expect(screen.queryByTestId('durable-permission-prompt')).toBeNull();
  });

  it('sends deny when Deny is clicked', async () => {
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);

    fireEvent.click(screen.getByTestId('durable-permission-deny'));

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('agent-1', 'req-1', 'deny');
    });
  });

  it('does not send a second decision while one is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    resolveSpy.mockReturnValue(new Promise((r) => { release = r; }));
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);

    fireEvent.click(screen.getByTestId('durable-permission-approve'));
    fireEvent.click(screen.getByTestId('durable-permission-deny'));
    fireEvent.click(screen.getByTestId('durable-permission-approve'));

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    await act(async () => { release({ status: 'resolved' }); });
  });

  it('explains a refused decision instead of silently dropping it', async () => {
    resolveSpy.mockResolvedValue({ status: 'rejected', reason: 'expired' });
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);

    fireEvent.click(screen.getByTestId('durable-permission-approve'));

    await waitFor(() => {
      expect(screen.getByTestId('permission-prompt-error').textContent).toContain('timed out');
    });
  });

  it('explains a transport failure', async () => {
    resolveSpy.mockRejectedValue(new Error('ipc down'));
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);

    fireEvent.click(screen.getByTestId('durable-permission-approve'));

    await waitFor(() => {
      expect(screen.getByTestId('permission-prompt-error').textContent).toContain('Could not reach');
    });
    // The request stays pending — the decision never landed.
    expect(usePendingPermissionStore.getState().byRequestId['req-1']).toBeDefined();
  });

  it('shows the oldest request first and counts the rest', () => {
    seed(makePermission({ requestId: 'newer', toolName: 'AskUserQuestion', createdAt: Date.now() + 5_000 }));
    seed(makePermission({ requestId: 'older', toolName: 'Skill', createdAt: Date.now() }));

    render(<DurablePermissionPrompt agentId="agent-1" />);

    expect(screen.getByTestId('durable-permission-prompt').getAttribute('data-request-id')).toBe('older');
    expect(screen.getByTestId('permission-queue-count').textContent).toContain('1 more request');
  });

  it('advances the countdown while the prompt is open', () => {
    vi.useFakeTimers();
    const createdAt = Date.now();
    seed(makePermission({ createdAt, timeoutMs: 10_000 }));

    render(<DurablePermissionPrompt agentId="agent-1" />);
    expect(screen.getByTestId('permission-countdown').textContent).toBe('10s');

    act(() => { vi.advanceTimersByTime(3_000); });

    expect(screen.getByTestId('permission-countdown').textContent).toBe('7s');
  });

  it('appears when a request arrives after mount', async () => {
    render(<DurablePermissionPrompt agentId="agent-1" />);
    expect(screen.queryByTestId('durable-permission-prompt')).toBeNull();

    act(() => { seed(makePermission()); });

    await waitFor(() => {
      expect(screen.getByTestId('durable-permission-prompt')).toBeTruthy();
    });
  });

  it('disappears when the request is settled elsewhere (Annex or timeout)', async () => {
    seed(makePermission());
    render(<DurablePermissionPrompt agentId="agent-1" />);
    expect(screen.getByTestId('durable-permission-prompt')).toBeTruthy();

    act(() => { usePendingPermissionStore.getState().removePending('req-1'); });

    await waitFor(() => {
      expect(screen.queryByTestId('durable-permission-prompt')).toBeNull();
    });
  });
});
