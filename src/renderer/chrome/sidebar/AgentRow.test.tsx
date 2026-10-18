import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentRow, HOVER_OPEN_MS } from './AgentRow';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { createChatViewState, useChatStore } from '../../stores/chatStore';
import type { Agent } from '../../../shared/types';

const durable = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', projectId: 'p1', name: 'snazzy-fox', kind: 'durable', status: 'sleeping', color: 'blue',
  branch: 'agent/snazzy-fox', worktreePath: '/src/ch/.clubhouse/agents/snazzy-fox', mcpIds: ['github'], model: 'opus', ...over,
} as Agent);

function setup(agent: Agent, extra: Partial<React.ComponentProps<typeof AgentRow>> = {}) {
  const onSelect = vi.fn();
  const onOpenTerminal = vi.fn();
  render(
    <AgentRow agent={agent} dot={agent.status === 'sleeping' ? 'sleeping' : 'working'} active={false} indent={20}
      projectPath="/src/ch" onSelect={onSelect} onOpenTerminal={onOpenTerminal} {...extra} />,
  );
  const row = screen.getByTestId(`agent-item-${agent.id}`);
  return { onSelect, onOpenTerminal, row, focusable: row.firstElementChild as HTMLElement };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/src/ch' }] as never });
  useAgentStore.setState({ deleteDialogAgent: null, agentSettingsOpenFor: null, agentSpawnedAt: {} });
});
afterEach(() => vi.useRealTimers());

describe('AgentRow identity and activity', () => {
  it.each([
    ['claude-code', 'Claude Code', 'C'],
    ['codex-cli', 'Codex', 'X'],
    ['copilot-cli', 'GitHub Copilot', 'G'],
    ['custom-provider', 'custom-provider', 'C'],
    [undefined, 'Claude Code', 'C'],
  ])('shows a neutral glyph for %s without adding a tree tab stop', (orchestrator, label, letter) => {
    const { focusable, onSelect } = setup(durable({ orchestrator }));
    const glyph = screen.getByRole('img', { name: label });
    expect(glyph).toHaveTextContent(letter!);
    expect(glyph).toHaveClass('text-ctp-overlay1');
    expect(glyph).not.toHaveAttribute('style');
    expect(glyph).not.toHaveAttribute('tabindex');
    expect(glyph).not.toHaveAttribute('data-testid');
    expect(focusable.querySelector('[tabindex="0"]')).toBeNull();
    expect(screen.getByText('SF')).toHaveClass('w-[18px]', 'h-[18px]');
    fireEvent.click(glyph);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('opens only the row hover card when hovering its provider glyph', () => {
    vi.useFakeTimers();
    setup(durable());
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Claude Code' }));
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('Claude Code');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keeps the glyph tile distinct from the selected row background', () => {
    const { row } = setup(durable(), { active: true });
    expect(row).toHaveClass('bg-surface-0');
    expect(screen.getByRole('img', { name: 'Claude Code' })).toHaveClass('bg-surface-1');
    expect(screen.getByRole('img', { name: 'Claude Code' })).not.toHaveClass('bg-surface-0');
  });

  it('shows the latest activity time and refreshes it without new agent events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    useAgentStore.setState({ agentSpawnedAt: { a1: Date.now() - 3_600_000 } });
    setup(durable({ status: 'running' }), {
      detailed: { state: 'idle', message: '', timestamp: Date.now() - 120_000 },
    });
    const time = screen.getByLabelText('Last activity: 2m ago');
    expect(time).toHaveAttribute('datetime', '2026-10-18T11:58:00.000Z');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(time).toHaveTextContent('3m ago');
    expect(time).toHaveAttribute('aria-label', 'Last activity: 3m ago');
  });

  it('falls back to the start time before the first activity event', () => {
    useAgentStore.setState({ agentSpawnedAt: { a1: Date.now() - 180_000 } });
    setup(durable({ status: 'running' }));
    expect(screen.getByLabelText('Started: 3m ago')).toBeInTheDocument();
  });

  it('uses the persisted sleep time instead of stale run activity', () => {
    const at = new Date(Date.now() - 7_200_000).toISOString();
    setup(durable({ lastSleep: { at, reason: 'user' } }), {
      detailed: { state: 'idle', message: '', timestamp: Date.now() - 10_000 },
    });
    expect(screen.getByLabelText('Sleeping since: 2h ago')).toHaveAttribute('datetime', at);
  });

  it.each([undefined, 'invalid-date'])('omits relative time when sleep time is %s', (at) => {
    const { row } = setup(durable({ lastSleep: at ? { at, reason: 'user' } : undefined }));
    expect(row.querySelector('time')).toBeNull();
  });

  it.each(['needs', 'error', 'idle'] as const)('preserves the %s note beside the glyph and time', (dot) => {
    setup(durable({ status: 'running', kind: 'quick' }), {
      dot,
      detailed: { state: 'idle', message: '', timestamp: Date.now() - 60_000 },
    });
    expect(screen.getByText(dot === 'needs' ? 'needs you' : dot === 'error' ? 'error' : 'quick')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Last activity: 1m ago')).toBeInTheDocument();
  });
});

describe('AgentRow menu', () => {
  it('opens the legacy context menu on right-click, with ctx-delete for a sleeping durable agent', () => {
    const { row } = setup(durable());
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeTruthy();
    expect(screen.getByTestId('ctx-wake')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ctx-delete'));
    expect(useAgentStore.getState().deleteDialogAgent).toBe('a1');
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });

  it('has an action-overflow button that opens the same menu', () => {
    const { row, onSelect } = setup(durable());
    const overflow = row.querySelector('[data-testid="action-overflow"]') as HTMLElement;
    fireEvent.click(overflow);
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the menu from the keyboard with Shift+F10 and selects with Enter', () => {
    const { focusable, onSelect } = setup(durable());
    fireEvent.keyDown(focusable, { key: 'F10', shiftKey: true });
    expect(screen.getByTestId('agent-context-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(focusable, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalled();
  });

  it('shows the agent before opening its settings', () => {
    const { row, onSelect } = setup(durable());
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByTestId('ctx-settings'));
    expect(onSelect).toHaveBeenCalled();
    expect(useAgentStore.getState().agentSettingsOpenFor).toBe('a1');
  });
});

describe('AgentRow hover card', () => {
  it('opens after a hover delay with the details and closes on leaving', () => {
    vi.useFakeTimers();
    const { row } = setup(durable());
    fireEvent.mouseEnter(row);
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card.textContent).toContain('agent/snazzy-fox');
    expect(card.textContent).toContain('.clubhouse/agents/snazzy-fox');
    expect(card.textContent).toContain('github');
    expect(card.textContent).toContain('Sleeping');
    fireEvent.mouseLeave(row);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('stays open while the pointer is on the card, and runs its actions', () => {
    vi.useFakeTimers();
    const { row, onOpenTerminal } = setup(durable());
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(screen.getByTestId('agent-hover-card'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('agent-hover-card')).toBeTruthy();
    expect(screen.getByTestId('hover-wake')).toBeTruthy();
    fireEvent.click(screen.getByText('Open terminal'));
    expect(onOpenTerminal).toHaveBeenCalled();
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('opens on keyboard focus and closes on Esc', () => {
    vi.useFakeTimers();
    const { focusable } = setup(durable({ status: 'running' }));
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('hover-stop')).toBeTruthy();
    fireEvent.keyDown(focusable, { key: 'Escape' });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('stays open when focus moves from the row into the card', () => {
    vi.useFakeTimers();
    const { focusable } = setup(durable({ status: 'running' }));
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const stop = screen.getByTestId('hover-stop');
    fireEvent.blur(focusable, { relatedTarget: stop });
    fireEvent.focus(stop);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId('agent-hover-card')).toBeTruthy();
    // Leaving the card for somewhere else closes it.
    fireEvent.blur(stop, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('keeps the overflow button beside the row, not inside the focusable element', () => {
    const { row, focusable } = setup(durable());
    const overflow = row.querySelector('[data-testid="action-overflow"]')!;
    expect(focusable.contains(overflow)).toBe(false);
  });

  it('offers no Open terminal where the project has no Terminal tab', () => {
    vi.useFakeTimers();
    const { row } = setup(durable(), { onOpenTerminal: undefined });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.queryByText('Open terminal')).toBeNull();
  });
});

describe('AgentRow hover card for a chat agent (#2197)', () => {
  const chatState = (state: 'running' | 'idle', turnStartedAt: number | null, live = true) =>
    useChatStore.setState({ agents: { a1: { ...createChatViewState('a1'), sessionId: 's1', state, turnStartedAt } }, live: { a1: live } });
  afterEach(() => useChatStore.setState({ agents: {}, live: {} }));

  it('times Working from the turn, as the chat header does, and offers Sleep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T09:22:29Z'));
    useAgentStore.setState({ agentSpawnedAt: { a1: Date.now() - 41 * 60_000 } });
    chatState('running', Date.now() - 9 * 60_000);
    const { focusable } = setup(durable({ status: 'running' }), { dot: 'working' });
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent('Working for 9m');
    expect(screen.getByTestId('hover-stop')).toHaveTextContent('Sleep');
  });

  it('says Done without repeating Idle once the turn ends', () => {
    vi.useFakeTimers();
    chatState('idle', null);
    const { focusable } = setup(durable({ status: 'running' }), {
      dot: 'idle', detailed: { state: 'idle', message: 'Idle', timestamp: Date.now() },
    });
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent('Done');
    expect(card).not.toHaveTextContent('Idle');
    expect(screen.getByTestId('hover-stop')).toHaveTextContent('Sleep');
  });

  it('ignores chat state left from an earlier session once the agent runs in the terminal (#2208)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T09:22:29Z'));
    useAgentStore.setState({ agentSpawnedAt: { a1: Date.now() - 41 * 60_000 } });
    chatState('running', Date.now() - 9 * 60_000, false);
    const { focusable } = setup(durable({ status: 'running' }), { dot: 'working' });
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('Working for 41m');
    expect(screen.getByTestId('hover-stop')).toHaveTextContent('Stop');
  });

  it('keeps Stop for an agent in the terminal', () => {
    vi.useFakeTimers();
    const { focusable } = setup(durable({ status: 'running' }));
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('hover-stop')).toHaveTextContent('Stop');
  });
});

describe('AgentRow helpers and creation (#2231)', () => {
  it('says why a helper couldn\'t start in the hover card', () => {
    vi.useFakeTimers();
    const { row } = setup(durable({ status: 'error', creationFailed: true, errorMessage: 'The branch already exists' }), { dot: 'error' });
    expect(screen.getByTestId('agent-row-note')).toHaveTextContent("couldn't start");
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent("Couldn't start");
    expect(card).toHaveTextContent('The branch already exists');
  });

  it('shows Starting while a helper is created, with the starting status dot', () => {
    vi.useFakeTimers();
    const { row } = setup(durable({ status: 'creating' }), { dot: 'starting' });
    expect(screen.getByTestId('agent-row-note')).toHaveTextContent('starting');
    expect(screen.getByRole('img', { name: 'Starting' })).toHaveAttribute('data-dot', 'starting');
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('Starting');
  });

  it('describes the row with its note and folded roll-up, which the name would hide', () => {
    const { focusable } = setup(durable({ status: 'creating' }), { dot: 'starting', helperCount: 2, helpersExpanded: false, helperWorking: 1 });
    expect(focusable).toHaveAccessibleName('snazzy-fox');
    expect(focusable).toHaveAccessibleDescription('starting 2 helpers, 1 working');
  });

  it('keeps an ordinary error as error', () => {
    setup(durable({ status: 'error', errorMessage: 'Exited with code 1' }), { dot: 'error' });
    expect(screen.getByTestId('agent-row-note')).toHaveTextContent('error');
  });

  it('gives a parent a caret that toggles its helpers, and a roll-up in place of the time when folded', () => {
    const onToggleHelpers = vi.fn();
    const { onSelect, focusable } = setup(durable(), { helperCount: 2, helpersExpanded: false, helperWorking: 1, onToggleHelpers });
    expect(focusable).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('helper-rollup')).toHaveTextContent('2 helpers');
    expect(screen.getByTestId('helper-rollup')).toHaveTextContent('1 working');
    expect(screen.queryByRole('time')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show helpers of snazzy-fox' }));
    expect(onToggleHelpers).toHaveBeenCalledWith('a1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
