import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub stores before importing command-actions
const mockToggle = vi.fn();
const mockToggleSettings = vi.fn();
const mockToggleHelp = vi.fn();
const mockSetActiveProject = vi.fn();
const mockToggleExplorerCollapse = vi.fn();
const mockToggleAccessoryCollapse = vi.fn();
const mockSetExplorerTab = vi.fn();
const mockPickAndAddProject = vi.fn();
const mockSetActiveAgent = vi.fn();
const mockOpenQuickAgentDialog = vi.fn();

vi.mock('../../stores/commandPaletteStore', () => ({
  useCommandPaletteStore: { getState: () => ({ toggle: mockToggle }) },
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: { getState: () => ({ toggleSettings: mockToggleSettings, toggleHelp: mockToggleHelp, setExplorerTab: mockSetExplorerTab, openQuickAgentDialog: mockOpenQuickAgentDialog }) },
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: { getState: () => ({ setActiveProject: mockSetActiveProject, pickAndAddProject: mockPickAndAddProject, activeProjectId: 'proj-1', projects: [{ id: 'proj-1', name: 'A' }, { id: 'proj-2', name: 'B' }] }) },
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: { getState: () => ({ toggleExplorerCollapse: mockToggleExplorerCollapse, toggleAccessoryCollapse: mockToggleAccessoryCollapse }) },
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: { getState: () => ({
    agents: {
      'a1': { id: 'a1', projectId: 'proj-1', kind: 'durable', name: 'Agent1' },
      'a2': { id: 'a2', projectId: 'proj-1', kind: 'durable', name: 'Agent2' },
    },
    setActiveAgent: mockSetActiveAgent,
  }) },
}));

import { getCommandActions, CommandAction } from './command-actions';

function findAction(id: string): CommandAction | undefined {
  return getCommandActions().find((a) => a.id === id);
}

describe('command-actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all expected actions', () => {
    const actions = getCommandActions();
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('command-palette');
    expect(ids).toContain('toggle-settings');
    expect(ids).toContain('toggle-help');
    expect(ids).toContain('go-home');
    expect(ids).toContain('toggle-sidebar');
    expect(ids).toContain('toggle-accessory');
    expect(ids).toContain('new-quick-agent');
    expect(ids).toContain('add-project');
    expect(ids).toContain('switch-agent-1');
    expect(ids).toContain('switch-agent-9');
    expect(ids).toContain('switch-project-1');
    expect(ids).toContain('switch-project-9');
  });

  it('command-palette is marked global', () => {
    const action = findAction('command-palette');
    expect(action?.global).toBe(true);
  });

  it('other actions are not global', () => {
    const action = findAction('toggle-settings');
    expect(action?.global).toBeFalsy();
  });

  it('command-palette action calls toggle', () => {
    findAction('command-palette')?.execute();
    expect(mockToggle).toHaveBeenCalled();
  });

  it('toggle-settings calls toggleSettings', () => {
    findAction('toggle-settings')?.execute();
    expect(mockToggleSettings).toHaveBeenCalled();
  });

  it('toggle-help calls toggleHelp', () => {
    findAction('toggle-help')?.execute();
    expect(mockToggleHelp).toHaveBeenCalled();
  });

  it('go-home calls setActiveProject(null)', () => {
    findAction('go-home')?.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith(null);
  });

  it('toggle-sidebar calls toggleExplorerCollapse', () => {
    findAction('toggle-sidebar')?.execute();
    expect(mockToggleExplorerCollapse).toHaveBeenCalled();
  });

  it('toggle-accessory calls toggleAccessoryCollapse', () => {
    findAction('toggle-accessory')?.execute();
    expect(mockToggleAccessoryCollapse).toHaveBeenCalled();
  });

  it('add-project calls pickAndAddProject', () => {
    findAction('add-project')?.execute();
    expect(mockPickAndAddProject).toHaveBeenCalled();
  });

  it('switch-project-1 switches to first project', () => {
    findAction('switch-project-1')?.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith('proj-1');
  });

  it('switch-project-2 switches to second project', () => {
    findAction('switch-project-2')?.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith('proj-2');
  });

  it('switch-agent-1 sets active agent to first durable agent', () => {
    findAction('switch-agent-1')?.execute();
    expect(mockSetActiveAgent).toHaveBeenCalledWith('a1', 'proj-1');
  });

  it('switch-agent-2 sets active agent to second durable agent', () => {
    findAction('switch-agent-2')?.execute();
    expect(mockSetActiveAgent).toHaveBeenCalledWith('a2', 'proj-1');
  });

  it('new-quick-agent opens the global quick agent dialog', () => {
    findAction('new-quick-agent')?.execute();
    expect(mockOpenQuickAgentDialog).toHaveBeenCalled();
  });
});
