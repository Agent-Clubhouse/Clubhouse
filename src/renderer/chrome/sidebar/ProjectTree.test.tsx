import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import { useChromeStore } from '../chromeStore';
import type { Agent, Project } from '../../../shared/types';

const DAY = 24 * 60 * 60 * 1000;
const project = (id: string): Project => ({ id, name: id.toUpperCase(), path: `/src/${id}` } as Project);
const agent = (id: string, projectId: string, over: Partial<Agent> = {}): Agent =>
  ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue', ...over }) as Agent;

function setup(over: Partial<ProjectTreeProps> = {}) {
  const props: ProjectTreeProps = {
    projects: [project('a'), project('b'), project('c'), project('old')],
    projectIcons: {},
    agentsByProject: { a: [agent('a1', 'a'), agent('a2', 'a', { status: 'sleeping' }), agent('a3', 'a')] },
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
  render(<ProjectTree {...props} />);
  return props;
}

const key = (k: string) => document.querySelector<HTMLElement>(`[data-tree-key="${k}"]`)!;

beforeEach(() => {
  const now = Date.now();
  useChromeStore.setState({
    pinnedProjectIds: [], collapsedProjectIds: ['b', 'c'], expandedFolds: [],
    projectActivity: { a: now, b: now, c: now, old: now - 10 * DAY }, idleDays: 7, idleOpen: false,
  });
});

describe('ProjectTree idle projects', () => {
  it('folds idle projects into one row at the bottom', () => {
    setup();
    expect(screen.queryByTestId('project-old')).toBeNull();
    const row = screen.getByTestId('idle-projects');
    expect(row.textContent).toContain('1 idle project');
    fireEvent.click(row);
    expect(screen.getByTestId('project-old')).toBeTruthy();
    expect(useChromeStore.getState().idleOpen).toBe(true);
  });

  it('keeps a pinned or selected project out of the idle row', () => {
    useChromeStore.setState({ pinnedProjectIds: ['old'] });
    setup();
    expect(screen.queryByTestId('idle-projects')).toBeNull();
    expect(screen.getByTestId('project-old')).toBeTruthy();
  });
});

describe('ProjectTree keyboard', () => {
  it('is a tree with one tab stop, on the selection', () => {
    setup();
    expect(screen.getByRole('tree')).toBeTruthy();
    const stops = [...document.querySelectorAll('[role="treeitem"]')].filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(stops.map((el) => el.getAttribute('data-tree-key'))).toEqual(['agent:a1']);
  });

  it('moves with the arrows and Home/End, and the tab stop follows', () => {
    setup();
    key('agent:a1').focus();
    fireEvent.keyDown(key('agent:a1'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(key('agent:a3'));
    expect(key('agent:a3').tabIndex).toBe(0);
    expect(key('agent:a1').tabIndex).toBe(-1);
    fireEvent.keyDown(key('agent:a3'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(key('agent:a1'));
    fireEvent.keyDown(key('agent:a1'), { key: 'Home' });
    expect(document.activeElement).toBe(key('project:a'));
    fireEvent.keyDown(key('project:a'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('idle-projects'));
  });

  it('Left goes to the parent, then collapses; Right expands, then steps in', () => {
    setup();
    key('agent:a1').focus();
    fireEvent.keyDown(key('agent:a1'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(key('project:a'));
    fireEvent.keyDown(key('project:a'), { key: 'ArrowLeft' });
    expect(useChromeStore.getState().collapsedProjectIds).toContain('a');
    fireEvent.keyDown(key('project:b'), { key: 'ArrowRight' });
    expect(useChromeStore.getState().collapsedProjectIds).not.toContain('b');
  });

  it('gives fold rows the fold as parent, and idle projects the idle row', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping'], idleOpen: true, collapsedProjectIds: ['b', 'c', 'old'] });
    setup();
    expect(key('agent:a2').dataset.treeParent).toBe('fold:a:sleeping');
    expect(key('agent:a2').getAttribute('aria-level')).toBe('3');
    key('agent:a2').focus();
    fireEvent.keyDown(key('agent:a2'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(key('fold:a:sleeping'));
    expect(key('project:old').getAttribute('aria-level')).toBe('2');
    key('project:old').focus();
    fireEvent.keyDown(key('project:old'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('idle-projects'));
  });

  it('Right on an expanded project with no agents stays put', () => {
    useChromeStore.setState({ collapsedProjectIds: ['c'] });
    setup();
    key('project:b').focus();
    fireEvent.keyDown(key('project:b'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(key('project:b'));
  });

  it('opens a project with Enter and its menu with Shift+F10', () => {
    const props = setup();
    fireEvent.keyDown(key('project:b'), { key: 'Enter' });
    expect(props.onSelectProject).toHaveBeenCalledWith('b');
    fireEvent.keyDown(key('project:b'), { key: 'F10', shiftKey: true });
    expect(screen.getByTestId('project-menu')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('project-menu-move-up'));
  });
});

describe('ProjectTree menus', () => {
  it('moves a project up or down within its section, disabled at the ends', () => {
    const props = setup();
    fireEvent.contextMenu(key('project:a'));
    expect(screen.getByTestId('project-menu-move-up').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('project-menu-move-down'));
    expect(props.onReorder).toHaveBeenCalledWith(['b', 'a', 'c', 'old']);
    fireEvent.contextMenu(key('project:c'));
    // The idle project is in another section, so c is last here.
    expect(screen.getByTestId('project-menu-move-down').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('project-menu-move-up'));
    expect(props.onReorder).toHaveBeenLastCalledWith(['a', 'c', 'b', 'old']);
  });

  it('opens project settings and pins from the menu', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('project-menu-button-b'));
    fireEvent.click(screen.getByTestId('project-menu-pin'));
    expect(useChromeStore.getState().pinnedProjectIds).toContain('b');
    fireEvent.click(screen.getByTestId('project-menu-button-b'));
    fireEvent.click(screen.getByTestId('project-menu-settings'));
    expect(props.onOpenSettings).toHaveBeenCalledWith('b');
  });

  it('moves a durable agent past its visible neighbour, keeping hidden sleeping agents in place', () => {
    const props = setup();
    // Saved order a1, a2 (sleeping, folded), a3. Shown: a1, a3.
    fireEvent.contextMenu(screen.getByTestId('agent-item-a1'));
    expect(screen.queryByTestId('ctx-move-up')).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-move-down'));
    expect(props.onReorderAgents).toHaveBeenCalledWith('a', ['a3', 'a2', 'a1']);
    fireEvent.contextMenu(screen.getByTestId('agent-item-a3'));
    expect(screen.queryByTestId('ctx-move-down')).toBeNull();
    expect(screen.getByTestId('ctx-move-up')).toBeTruthy();
  });

  it('moves sleeping agents among themselves inside the open fold', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping'] });
    const props = setup({ agentsByProject: { a: [agent('a1', 'a'), agent('s1', 'a', { status: 'sleeping' }), agent('a3', 'a'), agent('s2', 'a', { status: 'sleeping' })] } });
    fireEvent.contextMenu(screen.getByTestId('agent-item-s2'));
    fireEvent.click(screen.getByTestId('ctx-move-up'));
    expect(props.onReorderAgents).toHaveBeenCalledWith('a', ['a1', 's2', 'a3', 's1']);
  });

  it('has no move or settings items on a satellite', () => {
    setup({ onReorder: undefined, onOpenSettings: undefined, onReorderAgents: undefined, onNewAgent: undefined });
    fireEvent.contextMenu(key('project:a'));
    expect(screen.queryByTestId('project-menu-move-up')).toBeNull();
    expect(screen.queryByTestId('project-menu-settings')).toBeNull();
    expect(screen.getByTestId('project-menu-pin')).toBeTruthy();
  });
});

describe('ProjectTree finished quick agents', () => {
  it('shows a markdown summary as plain text in the row (#2092)', () => {
    useChromeStore.setState({ expandedFolds: ['a:finished'] });
    setup({
      completedByProject: {
        a: [{ id: 'q1', projectId: 'a', name: 'fix', mission: 'Fix it', summary: '**Updated** `src/a.ts`', filesModified: [], exitCode: 0, completedAt: Date.now() } as never],
      },
    });
    const row = screen.getByTestId('finished-quick-row-q1');
    expect(row.textContent).toContain('Updated src/a.ts');
    expect(row.textContent).not.toContain('**');
  });
});

describe('ProjectTree agent drag and keyboard reorder (#2115)', () => {
  /** jsdom has no DataTransfer; the handlers only need these. */
  const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' });
  const row = (id: string) => screen.getByTestId(`agent-item-${id}`);
  function drag(from: string, to: string, { drop = true } = {}) {
    const dt = dataTransfer();
    fireEvent.dragStart(row(from), { dataTransfer: dt });
    const accepted = fireEvent.dragOver(row(to), { dataTransfer: dt });
    if (drop) fireEvent.drop(row(to), { dataTransfer: dt });
    return { accepted };
  }

  it('drags an awake agent below another and saves the new order', () => {
    const props = setup();
    expect(row('a1').getAttribute('draggable')).toBe('true');
    drag('a1', 'a3');
    expect(props.onReorderAgents).toHaveBeenCalledWith('a', ['a3', 'a2', 'a1']);
  });

  it('shows the drop line below the target when moving down and above it when moving up', () => {
    setup();
    drag('a1', 'a3', { drop: false });
    expect(row('a3').querySelector('[data-testid="agent-drop-indicator"]')!.className).toContain('-bottom-px');
    fireEvent.dragEnd(row('a1'));
    expect(screen.queryByTestId('agent-drop-indicator')).toBeNull();

    drag('a3', 'a1', { drop: false });
    expect(row('a1').querySelector('[data-testid="agent-drop-indicator"]')!.className).toContain('-top-px');
  });

  it('does not drop an awake agent among sleeping ones', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping'] });
    const props = setup({ agentsByProject: { a: [agent('a1', 'a'), agent('a3', 'a'), agent('s1', 'a', { status: 'sleeping' }), agent('s2', 'a', { status: 'sleeping' })] } });
    const { accepted } = drag('a1', 's1');
    // fireEvent returns false when the handler called preventDefault (the drop was accepted).
    expect(accepted).toBe(true);
    expect(props.onReorderAgents).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-drop-indicator')).toBeNull();
  });

  it('reorders sleeping agents by drag inside the open fold', () => {
    useChromeStore.setState({ expandedFolds: ['a:sleeping'] });
    const props = setup({ agentsByProject: { a: [agent('a1', 'a'), agent('s1', 'a', { status: 'sleeping' }), agent('a3', 'a'), agent('s2', 'a', { status: 'sleeping' })] } });
    drag('s2', 's1');
    expect(props.onReorderAgents).toHaveBeenCalledWith('a', ['a1', 's2', 'a3', 's1']);
  });

  it('does not start a project drag when an agent row is dragged', () => {
    const props = setup();
    drag('a1', 'a3');
    expect(props.onReorder).not.toHaveBeenCalled();
  });

  it('leaves quick agents, lone agents and satellite rows undraggable', () => {
    setup({
      agentsByProject: { a: [agent('a1', 'a'), agent('q1', 'a', { kind: 'quick' })] },
    });
    expect(row('q1').hasAttribute('draggable')).toBe(false);
    // a1 is the only awake durable agent: nothing to reorder against.
    expect(row('a1').hasAttribute('draggable')).toBe(false);
  });

  it('has no draggable rows on a satellite', () => {
    setup({ onReorder: undefined, onReorderAgents: undefined });
    expect(row('a1').hasAttribute('draggable')).toBe(false);
  });

  it('Alt+Down and Alt+Up on a focused agent row move it, and plain arrows still move focus', () => {
    const props = setup();
    const a1 = key('agent:a1');
    fireEvent.keyDown(a1, { key: 'ArrowDown', altKey: true });
    expect(props.onReorderAgents).toHaveBeenLastCalledWith('a', ['a3', 'a2', 'a1']);
    fireEvent.keyDown(key('agent:a3'), { key: 'ArrowUp', altKey: true });
    expect(props.onReorderAgents).toHaveBeenLastCalledWith('a', ['a3', 'a2', 'a1']);
    expect(props.onReorderAgents).toHaveBeenCalledTimes(2);

    a1.focus();
    fireEvent.keyDown(a1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(key('agent:a3'));
    expect(props.onReorderAgents).toHaveBeenCalledTimes(2);
  });

  it('Alt+Up at the top of the group does nothing', () => {
    const props = setup();
    fireEvent.keyDown(key('agent:a1'), { key: 'ArrowUp', altKey: true });
    expect(props.onReorderAgents).not.toHaveBeenCalled();
  });

  it('Alt+Down and Alt+Up move a project header within its section', () => {
    useChromeStore.setState({ projectActivity: { a: Date.now(), b: Date.now(), c: Date.now(), old: Date.now() } });
    const props = setup();
    fireEvent.keyDown(key('project:b'), { key: 'ArrowDown', altKey: true });
    expect(props.onReorder).toHaveBeenLastCalledWith(['a', 'c', 'b', 'old']);
    fireEvent.keyDown(key('project:a'), { key: 'ArrowUp', altKey: true });
    expect(props.onReorder).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectTree keeps focus on a moved row (#2115 review)', () => {
  const rerenderInto = (props: ProjectTreeProps) =>
    render(<ProjectTree {...props} />, { container: screen.getByTestId('project-tree').closest('section')!.parentElement! });

  it('refocuses an agent row after Alt+Down, when moving its DOM node blurred it', () => {
    const props = setup();
    const a1 = key('agent:a1');
    a1.focus();
    fireEvent.keyDown(a1, { key: 'ArrowDown', altKey: true });
    expect(props.onReorderAgents).toHaveBeenCalledWith('a', ['a3', 'a2', 'a1']);
    // Chromium blurs a focused node React moves; jsdom doesn't, so do it here.
    a1.blur();
    expect(document.activeElement).toBe(document.body);
    rerenderInto({ ...props, agentsByProject: { a: [agent('a3', 'a'), agent('a2', 'a', { status: 'sleeping' }), agent('a1', 'a')] } });
    expect(document.activeElement).toBe(key('agent:a1'));
  });

  it('refocuses a project header after Alt+Down', () => {
    useChromeStore.setState({ projectActivity: { a: Date.now(), b: Date.now(), c: Date.now(), old: Date.now() } });
    const props = setup();
    const b = key('project:b');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown', altKey: true });
    b.blur();
    rerenderInto({ ...props, projects: [project('a'), project('c'), project('b'), project('old')] });
    expect(document.activeElement).toBe(key('project:b'));
  });

  it('marks movable rows with their keyboard shortcut', () => {
    setup();
    expect(key('agent:a1').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    expect(key('project:a').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
  });

  it('clears the drop line when the drag leaves the row', () => {
    setup();
    const dt = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByTestId('agent-item-a1'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('agent-item-a3'), { dataTransfer: dt });
    expect(screen.getByTestId('agent-drop-indicator')).toBeTruthy();
    fireEvent.dragLeave(screen.getByTestId('agent-item-a3'), { dataTransfer: dt, relatedTarget: document.body });
    expect(screen.queryByTestId('agent-drop-indicator')).toBeNull();
  });
});
