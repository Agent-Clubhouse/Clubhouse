import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import { useChromeStore } from '../chromeStore';
import type { Agent, Project } from '../../../shared/types';

const DAY = 24 * 60 * 60 * 1000;
const project = (id: string): Project => ({ id, name: id.toUpperCase(), path: `/src/${id}` } as Project);
const agent = (id: string, projectId: string, over: Partial<Agent> = {}): Agent =>
  ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue', ...over }) as Agent;

function baseProps(): ProjectTreeProps {
  return {
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
  };
}

function setup(over: Partial<ProjectTreeProps> = {}) {
  const props: ProjectTreeProps = { ...baseProps(), ...over };
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

describe('ProjectTree sort modes and inactive projects (#2116)', () => {
  const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' });
  const shownProjects = () => [...document.querySelectorAll<HTMLElement>('[data-tree-key^="project:"]')].map((el) => el.dataset.treeKey!.slice(8));
  const shownAgents = () => [...document.querySelectorAll<HTMLElement>('[data-tree-key^="agent:"]')].map((el) => el.dataset.treeKey!.slice(6));

  beforeEach(async () => {
    const { useToastStore } = await import('../../stores/toastStore');
    useToastStore.setState({ toasts: [] } as never);
    useChromeStore.setState({ projectSort: 'manual', agentSort: 'manual', inactiveProjectIds: [] });
  });
  const toasts = async () => {
    const { useToastStore } = await import('../../stores/toastStore');
    return (useToastStore.getState() as unknown as { toasts: Array<{ message: string }> }).toasts.map((t) => t.message);
  };

  it('in Recent project order, has no Move items, a note instead, and a drag only explains how to reorder', async () => {
    useChromeStore.setState({ projectSort: 'recent' });
    const props = setup();
    fireEvent.contextMenu(key('project:b'));
    expect(screen.queryByTestId('ctx-move-up')).toBeNull();
    expect(screen.getByText('Sorted by recent activity')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.dragStart(key('project:b'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(screen.getByTestId('project-group-a'), { dataTransfer: dataTransfer() });
    fireEvent.drop(screen.getByTestId('project-group-a'), { dataTransfer: dataTransfer() });
    expect(props.onReorder).not.toHaveBeenCalled();
    expect((await toasts()).some((m) => m.startsWith('Projects are sorted by recent activity'))).toBe(true);
  });

  it('in Recent agent order, agent rows have no Move items and a drag explains how to reorder', async () => {
    useChromeStore.setState({ agentSort: 'recent' });
    const props = setup();
    fireEvent.contextMenu(screen.getByTestId('agent-item-a1'));
    expect(screen.queryByTestId('ctx-move-down')).toBeNull();
    fireEvent.dragStart(screen.getByTestId('agent-item-a3'), { dataTransfer: dataTransfer() });
    expect(props.onReorderAgents).not.toHaveBeenCalled();
    expect((await toasts()).some((m) => m.startsWith('Agents are sorted by recent activity'))).toBe(true);
  });

  it('holds the given order while the pointer is over the tree, then catches up', () => {
    useChromeStore.setState({ projectSort: 'recent', agentSort: 'recent', collapsedProjectIds: ['b', 'c'] });
    const base = {
      projects: [project('a'), project('b'), project('c')],
      agentsByProject: { a: [agent('a1', 'a'), agent('a3', 'a')] },
    };
    const props = setup(base);
    const tree = screen.getByTestId('project-tree');
    // Re-render the same tree (same container, so the same root) with a new upstream order.
    const rerender = (over: Partial<ProjectTreeProps>) =>
      render(<ProjectTree {...props} {...over} />, { container: tree.closest('section')!.parentElement! });
    expect(shownProjects()).toEqual(['a', 'b', 'c']);
    fireEvent.pointerEnter(tree);
    rerender({ projects: [project('c'), project('a'), project('b')], agentsByProject: { a: [agent('a3', 'a'), agent('a1', 'a')] } });
    expect(shownProjects()).toEqual(['a', 'b', 'c']);
    expect(shownAgents()).toEqual(['a1', 'a3']);
    fireEvent.pointerLeave(screen.getByTestId('project-tree'));
    expect(shownProjects()).toEqual(['c', 'a', 'b']);
    expect(shownAgents()).toEqual(['a3', 'a1']);
  });

  it('does not hold the order in manual mode, so a reorder shows at once', () => {
    const props = setup({ projects: [project('a'), project('b')] });
    fireEvent.pointerEnter(screen.getByTestId('project-tree'));
    render(<ProjectTree {...props} projects={[project('b'), project('a')]} />, { container: screen.getByTestId('project-tree').closest('section')!.parentElement! });
    expect(shownProjects()).toEqual(['b', 'a']);
  });

  it('Mark inactive moves a project to the idle row at once; Mark active brings it back', () => {
    useChromeStore.setState({ idleOpen: true });
    setup();
    fireEvent.contextMenu(key('project:b'));
    fireEvent.click(screen.getByText('Mark inactive'));
    expect(useChromeStore.getState().inactiveProjectIds).toEqual(['b']);
    expect(screen.getByTestId('idle-projects').textContent).toBe('2 idle projects');
    expect(key('project:b').dataset.treeParent).toBe('idle');

    fireEvent.contextMenu(key('project:b'));
    expect(screen.queryByText('Mark inactive')).toBeNull();
    fireEvent.click(screen.getByText('Mark active'));
    expect(useChromeStore.getState().inactiveProjectIds).toEqual([]);
    expect(key('project:b').dataset.treeParent).toBeUndefined();
  });

  it('offers Mark active for a project that went idle by time, and no Mark inactive on a pinned one', () => {
    useChromeStore.setState({ idleOpen: true, pinnedProjectIds: ['c'] });
    setup();
    fireEvent.contextMenu(key('project:old'));
    fireEvent.click(screen.getByText('Mark active'));
    expect(key('project:old').dataset.treeParent).toBeUndefined();
    fireEvent.contextMenu(key('project:c'));
    expect(screen.queryByText('Mark inactive')).toBeNull();
  });

  it('switches project and agent order from the header menu', () => {
    setup();
    fireEvent.click(screen.getByTestId('sidebar-sort-menu'));
    fireEvent.click(screen.getByText('Projects most recent first'));
    fireEvent.click(screen.getByTestId('sidebar-sort-menu'));
    fireEvent.click(screen.getByText('Agents most recent first'));
    expect(useChromeStore.getState()).toMatchObject({ projectSort: 'recent', agentSort: 'recent' });
  });

  it('separates the project and agent order rows, and arrow keys step over the separator (#2581)', () => {
    useChromeStore.setState({ projectSort: 'recent', agentSort: 'manual' });
    setup();
    fireEvent.click(screen.getByTestId('sidebar-sort-menu'));
    const menu = screen.getByTestId('sidebar-sort');
    const rows = [...menu.children].map((el) => el.getAttribute('data-testid') ?? el.getAttribute('role'));
    expect(rows).toEqual([
      'sidebar-sort-projects-manual',
      'sidebar-sort-projects-recent',
      'separator',
      'sidebar-sort-agents-manual',
      'sidebar-sort-agents-recent',
    ]);
    // The two current rows are the ones either side of the separator, and both stay highlighted.
    for (const id of ['sidebar-sort-projects-recent', 'sidebar-sort-agents-manual']) {
      expect(screen.getByTestId(id).getAttribute('aria-current')).toBe('true');
      expect(screen.getByTestId(id).className).toContain('bg-surface-0');
    }
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-sort-projects-recent'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-sort-agents-manual'));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-sort-projects-recent'));
  });

  it('has no Mark inactive on a satellite', () => {
    setup({ onReorder: undefined, onOpenSettings: undefined, onReorderAgents: undefined, onNewAgent: undefined });
    fireEvent.contextMenu(key('project:a'));
    expect(screen.queryByText('Mark inactive')).toBeNull();
  });
});

describe('ProjectTree helpers nested under their parent (#2231)', () => {
  const row = (id: string) => screen.getByTestId(`agent-item-${id}`);
  const team = (over: Record<string, Partial<Agent>> = {}) => ({
    a: [
      agent('lead', 'a', over.lead),
      agent('h1', 'a', { parentAgentId: 'lead', ...over.h1 }),
      agent('other', 'a', over.other),
      agent('h2', 'a', { parentAgentId: 'lead', ...over.h2 }),
      agent('h2a', 'a', { parentAgentId: 'h2', ...over.h2a }),
    ],
  });
  const order = () => [...document.querySelectorAll('[data-agent-id]')].map((el) => el.getAttribute('data-agent-id'));
  const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' });

  beforeEach(() => useChromeStore.setState({ collapsedAgentIds: [] }));

  it('shows helpers under their parent on a guide line, a level deeper each time', () => {
    setup({ agentsByProject: team() });
    expect(order()).toEqual(['lead', 'h1', 'h2', 'h2a', 'other']);
    expect(key('agent:lead').getAttribute('aria-expanded')).toBe('true');
    expect(key('agent:other').hasAttribute('aria-expanded')).toBe(false);
    expect(key('agent:h1').dataset.treeParent).toBe('agent:lead');
    expect(key('agent:h1').getAttribute('aria-level')).toBe('3');
    expect(key('agent:h2a').dataset.treeParent).toBe('agent:h2');
    expect(key('agent:h2a').getAttribute('aria-level')).toBe('4');
    // Each level sits further in, and every helper hangs off a guide line.
    const pad = (id: string) => parseInt(key(`agent:${id}`).style.paddingLeft, 10);
    expect(pad('h1')).toBeGreaterThan(pad('lead'));
    expect(pad('h2a')).toBeGreaterThan(pad('h2'));
    expect(screen.getAllByTestId('helper-guide-line')).toHaveLength(3);
    // An expanded parent shows its helpers rather than a roll-up.
    expect(screen.queryByTestId('helper-rollup')).toBeNull();
  });

  it('folds and unfolds helpers with the caret, remembered per agent, without selecting the parent', () => {
    const props = setup({ agentsByProject: team() });
    fireEvent.click(screen.getByTestId('helpers-toggle-lead'));
    expect(props.onSelectAgent).not.toHaveBeenCalled();
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead']);
    expect(order()).toEqual(['lead', 'other']);
    expect(key('agent:lead').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('helpers-toggle-lead'));
    expect(useChromeStore.getState().collapsedAgentIds).toEqual([]);
    expect(order()).toEqual(['lead', 'h1', 'h2', 'h2a', 'other']);
  });

  it('starts folded for an agent folded before, and folds a nested parent on its own', () => {
    useChromeStore.setState({ collapsedAgentIds: ['h2'] });
    setup({ agentsByProject: team() });
    expect(order()).toEqual(['lead', 'h1', 'h2', 'other']);
    expect(key('agent:lead').getAttribute('aria-expanded')).toBe('true');
    expect(key('agent:h2').getAttribute('aria-expanded')).toBe('false');
  });

  it('rolls up a folded parent: the helper count, with a dot when one needs you or is working', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'] });
    setup({ agentsByProject: team(), detailed: { h2a: { state: 'needs_permission', message: '', timestamp: 1 }, h1: { state: 'working', message: '', timestamp: 1 } } });
    const rollup = within(row('lead')).getByTestId('helper-rollup');
    expect(rollup).toHaveTextContent('3 helpers');
    expect(rollup).toHaveTextContent('1 needs you');
    expect(within(rollup).getByTestId('helper-rollup-dot')).toHaveClass('bg-ctp-warning');
  });

  it('shows a working dot when no helper needs you, and no dot when none is busy', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'] });
    setup({ agentsByProject: team(), detailed: { h1: { state: 'working', message: '', timestamp: 1 } } });
    expect(within(row('lead')).getByTestId('helper-rollup-dot')).toHaveClass('bg-ctp-success');
  });

  it('shows no roll-up dot when every helper is quiet', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'] });
    setup({ agentsByProject: team({ h1: { status: 'sleeping' }, h2: { status: 'sleeping' }, h2a: { status: 'sleeping' } }) });
    expect(within(row('lead')).getByTestId('helper-rollup')).toHaveTextContent('3 helpers');
    expect(within(row('lead')).queryByTestId('helper-rollup-dot')).toBeNull();
  });

  /** Renders the tree, then lets a test change its props the way ChromeSidebar would. */
  function mount(over: Partial<ProjectTreeProps>) {
    const props = { ...baseProps(), ...over };
    const view = render(<ProjectTree {...props} />);
    return { props, update: (next: Partial<ProjectTreeProps>) => view.rerender(<ProjectTree {...props} {...next} />) };
  }
  const choose = (id: string) => act(() => useAgentStore.getState().setActiveAgent(id, 'a'));

  it('keeps folds at startup and on a project switch back, even with a folded helper selected', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead', 'h2', 'other'] });
    const { update } = mount({ agentsByProject: team(), activeAgentId: 'h2a' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead', 'h2', 'other']);
    // Switching away and back restores the project's agent without a fresh choice.
    act(() => useAgentStore.getState().restoreProjectAgent('a'));
    update({ activeAgentId: null, activeProjectId: 'b' });
    update({ activeAgentId: 'h2a', activeProjectId: 'a' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead', 'h2', 'other']);
  });

  it('unfolds the parents of a helper chosen from elsewhere', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead', 'h2', 'other'] });
    const { update } = mount({ agentsByProject: team(), activeAgentId: 'other' });
    choose('h2a');
    update({ activeAgentId: 'h2a' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['other']);
    expect(order()).toContain('h2a');
  });

  it('waits for the agents to load before unfolding', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'] });
    const { update } = mount({ agentsByProject: {}, activeAgentId: null });
    choose('h1');
    update({ activeAgentId: 'h1' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead']);
    update({ activeAgentId: 'h1', agentsByProject: team() });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual([]);
    expect(order()).toContain('h1');
  });

  it('opens the sleeping fold when the chosen helper is inside it', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'], expandedFolds: [] });
    const asleep = { status: 'sleeping' as const };
    const { update } = mount({ agentsByProject: team({ lead: asleep, h1: asleep, h2: asleep, h2a: asleep }), activeAgentId: 'other' });
    expect(order()).toEqual(['other']);
    choose('h1');
    update({ activeAgentId: 'h1' });
    expect(useChromeStore.getState().expandedFolds).toContain('a:sleeping');
    expect(order()).toEqual(['other', 'lead', 'h1', 'h2', 'h2a']);
  });

  it('leaves focus on the row when the caret is clicked', () => {
    setup({ agentsByProject: team() });
    const caret = screen.getByTestId('helpers-toggle-lead');
    // mousedown is cancelled, so the button never takes focus.
    expect(fireEvent.mouseDown(caret)).toBe(false);
    fireEvent.click(caret);
    expect(document.activeElement).toBe(key('agent:lead'));
  });

  it('announces a folded parent\'s roll-up as the row\'s description', () => {
    useChromeStore.setState({ collapsedAgentIds: ['lead'] });
    setup({ agentsByProject: team(), detailed: { h2a: { state: 'needs_permission', message: '', timestamp: 1 } } });
    const lead = screen.getByRole('treeitem', { name: 'lead' });
    expect(lead).toHaveAccessibleDescription('3 helpers, 1 needs you');
  });

  it('folds with Left and unfolds with Right, then steps into the first helper', () => {
    setup({ agentsByProject: team() });
    key('agent:lead').focus();
    fireEvent.keyDown(key('agent:lead'), { key: 'ArrowLeft' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual(['lead']);
    fireEvent.keyDown(key('agent:lead'), { key: 'ArrowRight' });
    expect(useChromeStore.getState().collapsedAgentIds).toEqual([]);
    fireEvent.keyDown(key('agent:lead'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(key('agent:h1'));
    fireEvent.keyDown(key('agent:h1'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(key('agent:lead'));
  });

  it('reorders helpers among their siblings only', () => {
    const props = setup({ agentsByProject: team() });
    fireEvent.keyDown(key('agent:h1'), { key: 'ArrowDown', altKey: true });
    expect(props.onReorderAgents).toHaveBeenLastCalledWith('a', ['lead', 'h2', 'other', 'h1', 'h2a']);
    // A helper can't be dragged out to the top level or under another parent.
    const dt = dataTransfer();
    fireEvent.dragStart(row('h1'), { dataTransfer: dt });
    fireEvent.dragOver(row('other'), { dataTransfer: dt });
    fireEvent.drop(row('other'), { dataTransfer: dt });
    fireEvent.dragStart(row('h2a'), { dataTransfer: dt });
    fireEvent.drop(row('h1'), { dataTransfer: dt });
    expect(props.onReorderAgents).toHaveBeenCalledTimes(1);
    // Top-level agents still reorder among themselves, helpers travelling with their parent.
    fireEvent.dragStart(row('other'), { dataTransfer: dt });
    fireEvent.dragOver(row('lead'), { dataTransfer: dt });
    fireEvent.drop(row('lead'), { dataTransfer: dt });
    expect(props.onReorderAgents).toHaveBeenLastCalledWith('a', ['other', 'h1', 'lead', 'h2', 'h2a']);
  });

  it('shows a helper being created as starting, and one that failed as couldn\'t start', () => {
    setup({ agentsByProject: team({ h1: { status: 'creating' }, h2: { status: 'error', creationFailed: true, errorMessage: 'The branch already exists' } }) });
    expect(within(row('h1')).getByTestId('agent-row-note')).toHaveTextContent('starting');
    expect(within(row('h1')).getByRole('img', { name: 'Starting' })).toBeTruthy();
    expect(within(row('h2')).getByTestId('agent-row-note')).toHaveTextContent("couldn't start");
    expect(within(row('h2')).getByTestId('agent-row-note')).toHaveClass('text-ctp-error');
  });
});

describe('ProjectTree helpers whose orchestrator is in another project (#2514)', () => {
  const order = () => [...document.querySelectorAll('[data-agent-id]')].map((el) => el.getAttribute('data-agent-id'));
  // The orchestrator `boss` is in project b; its helper `ui` is in project a, beside an agent of the same id.
  const cross = (over: Partial<Agent> = {}) => agent('ui', 'a', { parentAgentId: 'boss', parentProjectPath: '/src/b', parentProjectId: 'b', ...over });

  beforeEach(() => {
    useChromeStore.setState({ collapsedAgentIds: [], expandedFolds: [] });
    useProjectStore.setState({ projects: [project('a'), { ...project('b'), displayName: 'Annex' }] } as never);
    useAgentStore.setState({ agents: { boss: agent('boss', 'b') } } as never);
  });

  it('shows the helper as a root with plain "Helper of" text, never nested under an agent here', () => {
    setup({ agentsByProject: { a: [agent('lead', 'a'), agent('boss', 'a'), cross()] } });
    expect(order()).toEqual(['lead', 'boss', 'ui']);
    expect(screen.queryByTestId('helper-of-boss')).toBeNull();
    expect(screen.queryByTestId('helpers-toggle-boss')).toBeNull();
    expect(screen.getByTestId('other-project-parent-ui')).toHaveTextContent('Helper of boss in Annex');
    // Top-level agents here get no such line.
    expect(screen.queryByTestId('other-project-parent-lead')).toBeNull();
  });

  it('names the project by its folder when it isn\'t open, and the orchestrator generically when it isn\'t loaded', () => {
    useAgentStore.setState({ agents: {} } as never);
    setup({ agentsByProject: { a: [cross({ parentProjectPath: '/src/gone', parentProjectId: undefined })] } });
    expect(screen.getByTestId('other-project-parent-ui')).toHaveTextContent('Helper of an agent in gone');
  });

  it('opens the sleeping fold when the chosen helper is asleep in it', () => {
    const { rerender } = render(<ProjectTree {...baseProps()} agentsByProject={{ a: [agent('lead', 'a'), cross({ status: 'sleeping' })] }} activeAgentId="lead" />);
    expect(order()).toEqual(['lead']);
    act(() => useAgentStore.getState().setActiveAgent('ui', 'a'));
    rerender(<ProjectTree {...baseProps()} agentsByProject={{ a: [agent('lead', 'a'), cross({ status: 'sleeping' })] }} activeAgentId="ui" />);
    expect(useChromeStore.getState().expandedFolds).toContain('a:sleeping');
    expect(order()).toEqual(['lead', 'ui']);
  });
});
