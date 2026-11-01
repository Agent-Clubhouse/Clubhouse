import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import { FOLD_CLOSE_DELAY_MS } from './AutoClosingFold';
import { useChromeStore } from '../chromeStore';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent, CompletedQuickAgent, Project } from '../../../shared/types';

const project = (id: string): Project => ({ id, name: id.toUpperCase(), path: `/src/${id}` } as Project);
const agent = (id: string, projectId: string, over: Partial<Agent> = {}): Agent =>
  ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue', ...over }) as Agent;
const asleep = { status: 'sleeping' as const };

function props(over: Partial<ProjectTreeProps> = {}): ProjectTreeProps {
  return {
    projects: [project('a'), project('b')],
    projectIcons: {},
    agentsByProject: { a: [agent('a1', 'a'), agent('s1', 'a', asleep), agent('s2', 'a', asleep)] },
    detailed: {},
    completedByProject: {},
    activeProjectId: 'a',
    activeAgentId: 'a1',
    projectScopeId: null,
    selectedCompletedId: null,
    onReorder: vi.fn(),
    onSelectProject: vi.fn(),
    onNewAgent: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectCompleted: vi.fn(),
    onDismissCompleted: vi.fn(),
    onClearCompleted: vi.fn(),
    onOpenSettings: vi.fn(),
    onReorderAgents: vi.fn(),
    ...over,
  };
}

const key = (k: string) => document.querySelector<HTMLElement>(`[data-tree-key="${k}"]`)!;
const row = (id = 'a') => screen.getByTestId(`sleeping-fold-${id}`);
const fold = (id = 'a') => row(id).parentElement!.parentElement!;
const isOpen = (id = 'a') => useChromeStore.getState().expandedFolds.includes(`${id}:sleeping`);
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const enter = () => fireEvent.pointerEnter(fold());
const leave = () => fireEvent.pointerLeave(fold());

beforeEach(() => {
  vi.useFakeTimers();
  const now = Date.now();
  useChromeStore.setState({
    pinnedProjectIds: [], collapsedProjectIds: [], expandedFolds: ['a:sleeping'], pinnedSleepingFolds: [],
    projectActivity: { a: now, b: now }, idleDays: 7, idleOpen: false,
  });
  // Later focus counts as keyboard focus, whatever the last test did.
  fireEvent.keyDown(document.body, { key: 'Shift' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sleeping fold closing itself (#2580)', () => {
  it('closes 5 seconds after the pointer leaves, and not before', () => {
    render(<ProjectTree {...props()} />);
    enter();
    wait(60_000);
    expect(isOpen()).toBe(true);
    leave();
    wait(FOLD_CLOSE_DELAY_MS - 1);
    expect(isOpen()).toBe(true);
    wait(1);
    expect(isOpen()).toBe(false);
    expect(key('agent:s1')).toBeNull();
    // The row stays, to open it again.
    expect(row()).toBeTruthy();
  });

  it('returning cancels the timer, and leaving again starts it over', () => {
    render(<ProjectTree {...props()} />);
    enter();
    leave();
    wait(FOLD_CLOSE_DELAY_MS - 1);
    enter();
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    leave();
    wait(FOLD_CLOSE_DELAY_MS - 1);
    expect(isOpen()).toBe(true);
    wait(1);
    expect(isOpen()).toBe(false);
  });

  it('closes a fold restored open from an earlier session, which nothing has entered', () => {
    render(<ProjectTree {...props()} />);
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('stays closed once closed, and a click opens it again for another round', () => {
    render(<ProjectTree {...props()} />);
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(false);
    enter();
    fireEvent.click(row());
    expect(isOpen()).toBe(true);
    leave();
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('closes each project on its own', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping', 'b:sleeping'] });
    render(<ProjectTree {...props({ agentsByProject: { a: [agent('s1', 'a', asleep)], b: [agent('s3', 'b', asleep)] } })} />);
    enter();
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen('a')).toBe(true);
    expect(isOpen('b')).toBe(false);
  });

  it('leaves the finished fold alone', () => {
    useChromeStore.setState({ expandedFolds: ['a:finished'] });
    const completed = [{ id: 'c1', name: 'done', exitCode: 0 } as CompletedQuickAgent];
    render(<ProjectTree {...props({ completedByProject: { a: completed } })} />);
    expect(screen.getByTestId('finished-quick-row-c1')).toBeTruthy();
    wait(FOLD_CLOSE_DELAY_MS * 3);
    expect(useChromeStore.getState().expandedFolds).toEqual(['a:finished']);
    expect(screen.queryByTestId('sleeping-fold-pin-a')).toBeNull();
  });

  it('does not close while a row is being dragged', () => {
    render(<ProjectTree {...props()} />);
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const dragged = screen.getByTestId('agent-item-s1');
    fireEvent.dragStart(dragged, { dataTransfer });
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    fireEvent.dragEnd(screen.getByTestId('agent-item-s1'));
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('notices the pointer has moved on after what it was over went away', () => {
    render(<ProjectTree {...props()} />);
    enter();
    // No leave arrives: the next element reached is outside the fold.
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    fireEvent.pointerOver(screen.getByTestId('project-a'));
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('keeps counting the pointer as inside while it is over a portal opened from a row', () => {
    render(<ProjectTree {...props()} />);
    enter();
    const portal = document.createElement('div');
    document.body.appendChild(portal);
    fireEvent.pointerOver(portal);
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    portal.remove();
  });
});

describe('sleeping fold with the selection inside (#2580)', () => {
  it('stays open while a selected sleeping agent is inside, then closes once selection moves out', () => {
    const { rerender } = render(<ProjectTree {...props({ activeAgentId: 's1' })} />);
    wait(FOLD_CLOSE_DELAY_MS * 3);
    expect(isOpen()).toBe(true);
    rerender(<ProjectTree {...props({ activeAgentId: 'a1' })} />);
    wait(FOLD_CLOSE_DELAY_MS - 1);
    expect(isOpen()).toBe(true);
    wait(1);
    expect(isOpen()).toBe(false);
  });

  it('counts a sleeping helper nested inside the fold', () => {
    const agentsByProject = { a: [agent('lead', 'a', asleep), agent('h1', 'a', { ...asleep, parentAgentId: 'lead' })] };
    render(<ProjectTree {...props({ agentsByProject, activeAgentId: 'h1' })} />);
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
  });

  it('closes once the selected agent wakes and leaves the fold', () => {
    const { rerender } = render(<ProjectTree {...props({ activeAgentId: 's1' })} />);
    wait(FOLD_CLOSE_DELAY_MS);
    rerender(<ProjectTree {...props({ activeAgentId: 's1', agentsByProject: { a: [agent('s1', 'a'), agent('s2', 'a', asleep)] } })} />);
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('ignores the same agent id selected in another project', () => {
    render(<ProjectTree {...props({ activeProjectId: 'b', activeAgentId: 's1' })} />);
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('still lets the user close it by hand', () => {
    render(<ProjectTree {...props({ activeAgentId: 's1' })} />);
    fireEvent.click(row());
    expect(isOpen()).toBe(false);
  });

  it('holds a fold the reveal opened for a helper chosen from elsewhere', () => {
    useChromeStore.setState({ expandedFolds: [] });
    const agentsByProject = { a: [agent('other', 'a'), agent('lead', 'a', asleep), agent('h1', 'a', { ...asleep, parentAgentId: 'lead' })] };
    const { rerender } = render(<ProjectTree {...props({ agentsByProject, activeAgentId: 'other' })} />);
    act(() => { useAgentStore.setState({ activeAgentId: 'h1', agentSelectionSeq: useAgentStore.getState().agentSelectionSeq + 1 }); });
    rerender(<ProjectTree {...props({ agentsByProject, activeAgentId: 'h1' })} />);
    expect(isOpen()).toBe(true);
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
  });
});

describe('sleeping fold pin (#2580)', () => {
  const pin = (id = 'a') => screen.getByTestId(`sleeping-fold-pin-${id}`);

  it('keeps a pinned fold open after leaving, and unpinning starts the timer', () => {
    useChromeStore.setState({ pinnedSleepingFolds: ['a'] });
    render(<ProjectTree {...props()} />);
    enter();
    leave();
    wait(FOLD_CLOSE_DELAY_MS * 3);
    expect(isOpen()).toBe(true);
    expect(pin()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pin());
    expect(useChromeStore.getState().pinnedSleepingFolds).toEqual([]);
    expect(pin()).toHaveAttribute('aria-pressed', 'false');
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('pinning cancels a running timer, for that project only', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping', 'b:sleeping'] });
    render(<ProjectTree {...props({ agentsByProject: { a: [agent('s1', 'a', asleep)], b: [agent('s3', 'b', asleep)] } })} />);
    wait(FOLD_CLOSE_DELAY_MS - 1);
    fireEvent.click(pin('a'));
    expect(useChromeStore.getState().pinnedSleepingFolds).toEqual(['a']);
    wait(1);
    expect(isOpen('a')).toBe(true);
    expect(isOpen('b')).toBe(false);
  });

  it('does not toggle the fold when the pin is clicked', () => {
    render(<ProjectTree {...props()} />);
    fireEvent.click(pin());
    expect(isOpen()).toBe(true);
  });

  it('shows only on an open fold, and a pinned fold can still be closed by hand', () => {
    useChromeStore.setState({ pinnedSleepingFolds: ['a'] });
    render(<ProjectTree {...props()} />);
    fireEvent.click(row());
    expect(isOpen()).toBe(false);
    expect(screen.queryByTestId('sleeping-fold-pin-a')).toBeNull();
    expect(useChromeStore.getState().pinnedSleepingFolds).toEqual(['a']);
  });
});

describe('sleeping fold and keyboard focus (#2580)', () => {
  it('stays open while keyboard focus is inside, and closes 5 seconds after it leaves', () => {
    render(<ProjectTree {...props()} />);
    act(() => key('agent:s1').focus());
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    // Moving around inside the fold isn't leaving it.
    fireEvent.keyDown(key('agent:s1'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(key('agent:s2'));
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    act(() => key('agent:a1').focus());
    wait(FOLD_CLOSE_DELAY_MS - 1);
    expect(isOpen()).toBe(true);
    wait(1);
    expect(isOpen()).toBe(false);
  });

  it('coming back by keyboard cancels the timer', () => {
    render(<ProjectTree {...props()} />);
    act(() => key('agent:a1').focus());
    wait(FOLD_CLOSE_DELAY_MS - 1);
    act(() => row().focus());
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
  });

  it('waits for both: focus still inside after the pointer leaves, then the pointer back after focus leaves', () => {
    render(<ProjectTree {...props()} />);
    enter();
    act(() => key('agent:s1').focus());
    leave();
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    enter();
    act(() => key('agent:a1').focus());
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    leave();
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('does not let focus from a click keep the fold open', () => {
    render(<ProjectTree {...props()} />);
    enter();
    fireEvent.pointerDown(row());
    act(() => row().focus());
    fireEvent.click(row());
    fireEvent.click(row());
    expect(document.activeElement).toBe(row());
    leave();
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('counts a key pressed on the row that was clicked', () => {
    render(<ProjectTree {...props()} />);
    fireEvent.pointerDown(row());
    act(() => row().focus());
    fireEvent.keyDown(row(), { key: 'Shift' });
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
  });

  it('notices focus went away with a row that left the fold', () => {
    const { rerender } = render(<ProjectTree {...props()} />);
    act(() => key('agent:s1').focus());
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
    // Removed from the list altogether: nothing receives focus, and React sends no blur.
    rerender(<ProjectTree {...props({ agentsByProject: { a: [agent('a1', 'a'), agent('s2', 'a', asleep)] } })} />);
    wait(FOLD_CLOSE_DELAY_MS);
    expect(isOpen()).toBe(false);
  });

  it('keeps counting focus as inside while the window is away', () => {
    render(<ProjectTree {...props()} />);
    const focused = key('agent:s1');
    act(() => focused.focus());
    // The window losing focus: a blur with the element still the active one.
    fireEvent.focusOut(focused, { relatedTarget: null });
    expect(document.activeElement).toBe(focused);
    wait(FOLD_CLOSE_DELAY_MS * 2);
    expect(isOpen()).toBe(true);
  });

  it('reaches the pin by Tab from the row, as a real button outside the treeitem', () => {
    render(<ProjectTree {...props()} />);
    const pin = screen.getByTestId('sleeping-fold-pin-a');
    expect(pin.tabIndex).toBe(0);
    expect(pin.closest('[role="treeitem"]')).toBeNull();
    expect(row().contains(pin)).toBe(false);
  });
});
