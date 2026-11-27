import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentRow, HOVER_OPEN_MS } from './AgentRow';
import { TOOLTIP_DELAY_MS } from '../../components/Tooltip';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { createChatViewState, useChatStore } from '../../stores/chatStore';
import type { Agent } from '../../../shared/types';
import { useAgentSettingsPages } from '../../features/agents/agentSettingsPages';

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

  it.each([
    [{ access: 'full_access', freeAgentMode: true }, 'Full access'],
    [{ access: 'auto', freeAgentMode: true }, 'Auto'],
    [{ access: 'plan' }, 'Plan'],
    [{}, 'Ask first'],
    // A record from before #2761 that only says it's on.
    [{ freeAgentMode: true }, 'Auto or Full access'],
  ] as const)('puts no access marker on the row and shows access as plain text in the hover card (%o)', (over, label) => {
    vi.useFakeTimers();
    const { row } = setup(durable(over as Partial<Agent>));
    expect(screen.queryByRole('img', { name: /free agent|access/i })).toBeNull();
    expect(row.querySelector('.bg-ctp-error')).toBeNull();
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent(`Access${label}`);
    expect(card).not.toHaveTextContent(/free agent/i);
    expect(card.querySelector('.text-ctp-error')).toBeNull();
  });

  it('shows the chat session\'s level in the hover card while chat runs the agent', () => {
    vi.useFakeTimers();
    useChatStore.setState((s) => ({ agents: { ...s.agents, a1: { ...createChatViewState('a1'), level: 'auto' } }, live: { ...s.live, a1: true } }));
    const { row } = setup(durable({ status: 'running', access: 'ask' }));
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('AccessAuto');
    useChatStore.setState((s) => ({ live: { ...s.live, a1: false } }));
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

  it('offers Change CLI for a failed launch and reveals the agent before its runtime settings', () => {
    const { row, onSelect } = setup(durable({ status: 'error', errorMessage: 'CLI unavailable' }));
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('button', { name: 'Change CLI' }));
    expect(onSelect).toHaveBeenCalled();
    expect(useAgentStore.getState().agentSettingsOpenFor).toBe('a1');
    expect(useAgentSettingsPages.getState().requestedPage).toEqual({ agentId: 'a1', page: 'runtime' });
  });

  it('does not offer a CLI change when folder creation failed', () => {
    const { row } = setup(durable({ status: 'error', creationFailed: true }));
    fireEvent.contextMenu(row);
    expect(screen.queryByRole('button', { name: 'Change CLI' })).toBeNull();
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

  it('clamps a long command with an unbroken token, keeps the width, and shows the full text in a tooltip (#3212)', () => {
    vi.useFakeTimers();
    const token = '-only-testing:' + 'x'.repeat(200);
    const command = `Running xcodebuild test -scheme App -destination 'platform=iOS Simulator' ${token} ${'then more words '.repeat(30)}`;
    const { row } = setup(durable({ status: 'running' }), {
      dot: 'working',
      detailed: { state: 'working', message: command, timestamp: Date.now() } as never,
    });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    // Width stays fixed.
    expect(card.style.width).toBe('280px');
    // The activity text is clamped and breaks inside long tokens.
    const message = screen.getByTestId('agent-hover-message');
    expect(message).toHaveClass('line-clamp-3', '[overflow-wrap:anywhere]');
    expect(message.textContent).toBe(command);
    // The detail rows and actions are still there.
    for (const label of ['Runs on', 'Branch', 'Worktree', 'Access']) expect(card).toHaveTextContent(label);
    expect(screen.getByText('Open terminal')).toBeTruthy();
    expect(screen.getByTestId('hover-stop')).toBeTruthy();
    // The full text is reachable from the tooltip, which breaks the token too.
    fireEvent.mouseEnter(message);
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe(command);
    expect(tip.querySelector('.\\[overflow-wrap\\:anywhere\\]')).not.toBeNull();
  });

  it('offers no Open terminal where the project has no Terminal tab', () => {
    vi.useFakeTimers();
    const { row } = setup(durable(), { onOpenTerminal: undefined });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.queryByText('Open terminal')).toBeNull();
  });
});

describe('AgentRow hover model and provider', () => {
  afterEach(() => useChatStore.setState({ agents: {}, live: {} }));

  it.each([true, false])('uses session values only for a live chat (%s)', (live) => {
    vi.useFakeTimers();
    useChatStore.setState({
      agents: { a1: { ...createChatViewState('a1'), provider: 'codex-cli', model: 'gpt-6', startModel: 'sonnet',
        models: [{ id: 'gpt-6', label: 'GPT 6' }, { id: 'sonnet', label: 'Sonnet 5.5' }] } },
      live: { a1: live },
    });
    const { row } = setup(durable({ status: 'running', orchestrator: 'claude-code', model: 'sonnet' }));
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent(live ? 'Codex, GPT 6. Next start: Sonnet 5.5' : 'Claude Code, Sonnet');
    if (!live) expect(card).not.toHaveTextContent('GPT 6');
  });

  it('shows the saved values without a chat session', () => {
    vi.useFakeTimers();
    useChatStore.setState({ agents: {}, live: {} });
    const { row } = setup(durable({ orchestrator: 'claude-code', model: 'sonnet' }));
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('Claude Code, Sonnet');
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

  it('says Idle once the turn ends, with no Idle message line under it', () => {
    vi.useFakeTimers();
    chatState('idle', null);
    const { focusable } = setup(durable({ status: 'running' }), {
      dot: 'idle', detailed: { state: 'idle', message: 'Idle', timestamp: Date.now() },
    });
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    expect(card).toHaveTextContent('Idle');
    expect(screen.queryByTestId('agent-hover-message')).toBeNull();
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

describe('AgentRow remote computer identity (#3607)', () => {
  const LONG = 'Mason-Studio-Mac-Pro-Upstairs';

  it('names the row with the full alias, not the clipped label', () => {
    const { focusable } = setup(durable(), { machine: 'Mason-Studio-…', machineName: LONG });
    expect(focusable).toHaveAccessibleName(`snazzy-fox on ${LONG}`);
    expect(screen.getByRole('treeitem', { name: `snazzy-fox on ${LONG}` })).toBe(focusable);
    expect(screen.getByTestId('agent-row-machine')).toHaveTextContent('Mason-Studio-…');
  });

  it('adds offline to the row name', () => {
    const { focusable } = setup(durable(), { machine: 'Studio', machineName: 'Studio', offline: true });
    expect(focusable).toHaveAccessibleName('snazzy-fox on Studio, offline');
  });

  it('keeps the agent name for a local row', () => {
    const { focusable } = setup(durable());
    expect(focusable).toHaveAccessibleName('snazzy-fox');
  });

  it('shows the whole alias in a Computer field of the hover card, wrapped rather than cut', () => {
    vi.useFakeTimers();
    const { row } = setup(durable(), { machine: 'Mason-Studio-…', machineName: LONG });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    const card = screen.getByTestId('agent-hover-card');
    const term = Array.from(card.querySelectorAll('dt')).find((t) => t.textContent === 'Computer')!;
    expect(term).toBeTruthy();
    const value = term.nextElementSibling as HTMLElement;
    expect(value).toHaveTextContent(LONG);
    expect(value.className).not.toContain('truncate');
    // "Runs on" still means the CLI and model.
    expect(card).toHaveTextContent('Runs onClaude Code');
  });

  it('says offline in the Computer field of the card', () => {
    vi.useFakeTimers();
    const first = setup(durable(), { machine: 'Studio', machineName: 'Studio', offline: true });
    fireEvent.mouseEnter(first.row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('ComputerStudio (offline)');
  });

  it('has no Computer field for a local agent', () => {
    vi.useFakeTimers();
    const { row } = setup(durable());
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).not.toHaveTextContent('Computer');
  });

  it('opens the card with the full alias from keyboard focus and closes it on Escape', () => {
    vi.useFakeTimers();
    const { focusable } = setup(durable(), { machine: 'Mason-Studio-…', machineName: LONG });
    fireEvent.focus(focusable);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent(LONG);
    fireEvent.keyDown(focusable, { key: 'Escape' });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('keeps the computer label and offline text while the row is hovered; only the time and note give way to the actions', () => {
    setup(durable({ status: 'running' }), { machine: 'Studio', machineName: 'Studio', offline: true });
    const machine = screen.getByTestId('agent-row-machine');
    // Not inside anything the row hides on hover, and with a shape of its own besides the text.
    expect(machine.closest('[class*="group-hover/row:hidden"]')).toBeNull();
    expect(screen.getByTestId('agent-row-offline').closest('[class*="group-hover/row:hidden"]')).toBeNull();
    expect(machine.parentElement!.parentElement!.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('hides the note on hover but not the computer', () => {
    setup(durable({ kind: 'quick', status: 'running' }), { machine: 'Studio', machineName: 'Studio' });
    expect(screen.getByTestId('agent-row-note').closest('[class*="group-hover/row:hidden"]')).not.toBeNull();
    expect(screen.getByTestId('agent-row-machine').closest('[class*="group-hover/row:hidden"]')).toBeNull();
  });

  it('keeps the label inside the 72 px cap at a narrow width, with the name truncating before it', () => {
    setup(durable(), { machine: 'Mason-Studio-…', machineName: LONG });
    const label = screen.getByTestId('agent-row-machine');
    expect(label).toHaveClass('truncate');
    expect(label.parentElement).toHaveClass('max-w-[72px]', 'min-w-0');
    expect(screen.getByText('snazzy-fox')).toHaveClass('truncate');
  });

  it('shows the ID tail of a colliding computer in its own element that the width never cuts', () => {
    setup(durable(), { machine: 'Mason-Stu…', machineId: 'BBCC', machineName: 'Mason-Studio (ID BBCC)' });
    const label = screen.getByTestId('agent-row-machine');
    const tail = screen.getByTestId('agent-row-machine-id');
    expect(tail).toHaveTextContent('BBCC');
    // Beside the label, not inside what truncates, and not shrinking.
    expect(label).toHaveClass('truncate');
    expect(label).not.toContainElement(tail);
    expect(tail.parentElement).toBe(label.parentElement);
    expect(tail).toHaveClass('flex-shrink-0');
    expect(tail).not.toHaveClass('truncate');
    expect(tail.closest('.truncate')).toBeNull();
  });

  it('has no ID element for a computer whose alias is unique', () => {
    setup(durable(), { machine: 'Studio', machineName: 'Studio' });
    expect(screen.queryByTestId('agent-row-machine-id')).toBeNull();
  });

  it('names the card from the full alias when only the short label is given', () => {
    vi.useFakeTimers();
    const { row } = setup(durable(), { machine: 'Other computer' });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('agent-hover-card')).toHaveTextContent('ComputerOther computer');
  });
});
