import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { agentDot, chatDetailedStatus, chatDot, DOT_LABEL, StatusDot, statusCounts, statusRingColor } from './agent-status';

describe('agent status vocabulary', () => {
  it('uses the five words, with Done for an agent between turns', () => {
    expect([DOT_LABEL.working, DOT_LABEL.needs, DOT_LABEL.error, DOT_LABEL.sleeping, DOT_LABEL.idle])
      .toEqual(['Working', 'Needs you', 'Error', 'Sleeping', 'Done']);
  });

  it('maps chat session states onto the same dots', () => {
    expect(chatDot('running')).toBe('working');
    expect(chatDot('waiting_permission')).toBe('needs');
    expect(chatDot('waiting_input')).toBe('needs');
    expect(chatDot('idle')).toBe('idle');
    expect(chatDot('sleeping')).toBe('sleeping');
    expect(chatDot('error')).toBe('error');
    expect(chatDot(null)).toBe('starting');
  });

  it('colors avatar rings like the dot, so a done agent is not shown as working', () => {
    expect(statusRingColor({ status: 'running' }, { state: 'working' })).toBe('rgb(var(--ctp-success))');
    expect(statusRingColor({ status: 'running' }, { state: 'idle' })).toBe('rgb(var(--ctp-info))');
    expect(statusRingColor({ status: 'running' }, { state: 'needs_permission' })).toBe('rgb(var(--ctp-warning))');
    expect(statusRingColor({ status: 'running' }, { state: 'tool_error' })).toBe('rgb(var(--ctp-error))');
    expect(statusRingColor({ status: 'sleeping' }, undefined)).toBe('rgb(var(--ctp-overlay0))');
  });

  it('counts agents per status, what needs attention first', () => {
    const agents = [
      { id: 'a', status: 'running' }, { id: 'b', status: 'running' }, { id: 'c', status: 'sleeping' }, { id: 'd', status: 'running' },
    ] as const;
    const detailed = { a: { state: 'working' }, b: { state: 'needs_permission' } } as const;
    expect(statusCounts([...agents], detailed)).toEqual([
      { dot: 'needs', count: 1 }, { dot: 'working', count: 1 }, { dot: 'idle', count: 1 }, { dot: 'sleeping', count: 1 },
    ]);
    expect(agentDot({ status: 'error' }, undefined)).toBe('error');
  });

  it('keeps an agent working between tool calls (post_tool reports idle + Thinking)', () => {
    expect(agentDot({ status: 'running' }, { state: 'idle', message: 'Thinking' })).toBe('working');
    expect(agentDot({ status: 'running' }, { state: 'idle', message: 'Idle' })).toBe('idle');
    expect(statusRingColor({ status: 'running' }, { state: 'idle', message: 'Thinking' })).toBe('rgb(var(--ctp-success))');
  });

  it('renders an 8px dot named by its word', () => {
    render(<StatusDot dot="needs" />);
    const dot = screen.getByRole('img', { name: 'Needs you' });
    expect(dot.className).toContain('w-2 h-2');
    expect(dot.className).toContain('bg-ctp-warning');
  });
});

describe('chatDetailedStatus (#2197)', () => {
  const running = { status: 'running' as const };
  const thinking = { state: 'idle' as const, message: 'Thinking', timestamp: 5 };

  it('keeps hook detail that agrees with the chat state', () => {
    expect(chatDetailedStatus(running, thinking, { state: 'running', turnStartedAt: 1 })).toBe(thinking);
    const perm = { state: 'needs_permission' as const, message: 'Needs permission', toolName: 'Edit', timestamp: 5 };
    expect(chatDetailedStatus(running, perm, { state: 'waiting_permission', turnStartedAt: 1 })).toBe(perm);
  });

  it('fills in what the hook status lost or got wrong', () => {
    expect(chatDetailedStatus(running, undefined, { state: 'running', turnStartedAt: 7 }))
      .toEqual({ state: 'working', message: 'Working', timestamp: 7 });
    expect(chatDetailedStatus(running, thinking, { state: 'idle', turnStartedAt: null }))
      .toEqual({ state: 'idle', message: 'Idle', timestamp: 5 });
    expect(agentDot(running, chatDetailedStatus(running, undefined, { state: 'waiting_permission', turnStartedAt: 1 }))).toBe('needs');
  });

  it('defers to hook and agent status when the chat state can\'t say', () => {
    for (const state of [null, 'sleeping', 'error'] as const) {
      expect(chatDetailedStatus(running, thinking, { state, turnStartedAt: null })).toBe(thinking);
    }
    expect(chatDetailedStatus({ status: 'sleeping' }, undefined, { state: 'running', turnStartedAt: 1 })).toBeUndefined();
  });
});
