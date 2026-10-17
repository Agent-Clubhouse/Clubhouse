import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentRow, HOVER_OPEN_MS } from './AgentRow';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
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
  return { onSelect, onOpenTerminal, row: screen.getByTestId(`agent-item-${agent.id}`) };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/src/ch' }] as never });
  useAgentStore.setState({ deleteDialogAgent: null, agentSettingsOpenFor: null, agentSpawnedAt: {} });
});
afterEach(() => vi.useRealTimers());

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
    const { row, onSelect } = setup(durable());
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(screen.getByTestId('agent-context-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(row, { key: 'Enter' });
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
    const { row } = setup(durable({ status: 'running' }));
    fireEvent.focus(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.getByTestId('hover-stop')).toBeTruthy();
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('offers no Open terminal where the project has no Terminal tab', () => {
    vi.useFakeTimers();
    const { row } = setup(durable(), { onOpenTerminal: undefined });
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_MS); });
    expect(screen.queryByText('Open terminal')).toBeNull();
  });
});
