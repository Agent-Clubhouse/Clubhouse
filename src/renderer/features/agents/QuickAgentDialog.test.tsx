import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { QuickAgentDialog } from './QuickAgentDialog';

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({
    options: [
      { id: 'default', label: 'Default' },
      { id: 'opus', label: 'Opus' },
    ],
    loading: false,
  }),
}));

function setupStores(overrides?: { quickAgentDialogOpen?: boolean; activeProjectId?: string | null }) {
  const mockSpawnQuickAgent = vi.fn().mockResolvedValue('agent-123');
  const mockCloseDialog = vi.fn();
  const mockSetActiveProject = vi.fn();
  const mockSetExplorerTab = vi.fn();

  useProjectStore.setState({
    projects: [
      { id: 'proj-1', name: 'my-app', path: '/project1' },
      { id: 'proj-2', name: 'other-app', path: '/project2' },
    ],
    activeProjectId: overrides?.activeProjectId !== undefined ? overrides.activeProjectId : 'proj-1',
    setActiveProject: mockSetActiveProject,
  });

  useAgentStore.setState({
    agents: {
      'durable-1': {
        id: 'durable-1',
        projectId: 'proj-1',
        name: 'bold-falcon',
        kind: 'durable',
        status: 'running',
        color: 'indigo',
      },
      'durable-2': {
        id: 'durable-2',
        projectId: 'proj-1',
        name: 'swift-eagle',
        kind: 'durable',
        status: 'sleeping',
        color: 'green',
      },
      'durable-3': {
        id: 'durable-3',
        projectId: 'proj-2',
        name: 'calm-bear',
        kind: 'durable',
        status: 'running',
        color: 'red',
      },
    },
    spawnQuickAgent: mockSpawnQuickAgent,
  });

  useOrchestratorStore.setState({
    enabled: ['claude-code', 'codex'],
    allOrchestrators: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'CC',
        capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
      },
      {
        id: 'codex',
        displayName: 'Codex',
        shortName: 'CX',
        capabilities: { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false },
      },
    ],
  });

  useUIStore.setState({
    quickAgentDialogOpen: overrides?.quickAgentDialogOpen ?? true,
    closeQuickAgentDialog: mockCloseDialog,
    openQuickAgentDialog: vi.fn(),
    setExplorerTab: mockSetExplorerTab,
  });

  return { mockSpawnQuickAgent, mockCloseDialog, mockSetActiveProject, mockSetExplorerTab };
}

describe('QuickAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when dialog is closed', () => {
    setupStores({ quickAgentDialogOpen: false });
    const { container } = render(<QuickAgentDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('renders dialog when open', () => {
    setupStores();
    render(<QuickAgentDialog />);
    expect(screen.getByText('New Quick Agent')).toBeInTheDocument();
  });

  it('shows project selector with all projects', () => {
    setupStores();
    render(<QuickAgentDialog />);
    const projectSelect = screen.getAllByRole('combobox')[0];
    expect(projectSelect).toBeInTheDocument();
    // Check project options
    const options = projectSelect.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('my-app');
    expect(options[1].textContent).toBe('other-app');
  });

  it('defaults project to active project', () => {
    setupStores({ activeProjectId: 'proj-2' });
    render(<QuickAgentDialog />);
    const projectSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(projectSelect.value).toBe('proj-2');
  });

  it('defaults to first project when no active project', () => {
    setupStores({ activeProjectId: null });
    render(<QuickAgentDialog />);
    const projectSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(projectSelect.value).toBe('proj-1');
  });

  it('shows parent agent selector with durables for selected project', () => {
    setupStores();
    render(<QuickAgentDialog />);
    const parentSelect = screen.getAllByRole('combobox')[1];
    const options = parentSelect.querySelectorAll('option');
    // "None (project root)" + 2 durables for proj-1
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toBe('None (project root)');
    expect(options[1].textContent).toBe('bold-falcon');
    expect(options[2].textContent).toBe('swift-eagle');
  });

  it('updates parent agent list when project changes', () => {
    setupStores();
    render(<QuickAgentDialog />);
    const projectSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(projectSelect, { target: { value: 'proj-2' } });
    const parentSelect = screen.getAllByRole('combobox')[1];
    const options = parentSelect.querySelectorAll('option');
    // "None (project root)" + 1 durable for proj-2
    expect(options).toHaveLength(2);
    expect(options[1].textContent).toBe('calm-bear');
  });

  it('shows orchestrator selector', () => {
    setupStores();
    render(<QuickAgentDialog />);
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
  });

  it('shows model selector', () => {
    setupStores();
    render(<QuickAgentDialog />);
    expect(screen.getByText('Model')).toBeInTheDocument();
  });

  it('shows Free Agent Mode checkbox', () => {
    setupStores();
    render(<QuickAgentDialog />);
    expect(screen.getByText('Free Agent Mode')).toBeInTheDocument();
  });

  it('shows prompt textarea', () => {
    setupStores();
    render(<QuickAgentDialog />);
    expect(screen.getByPlaceholderText('What should this quick agent do?')).toBeInTheDocument();
  });

  it('Start Agent button is disabled when prompt is empty', () => {
    setupStores();
    render(<QuickAgentDialog />);
    const startBtn = screen.getByText('Start Agent');
    expect(startBtn).toBeDisabled();
  });

  it('Start Agent button is enabled when prompt has text', () => {
    setupStores();
    render(<QuickAgentDialog />);
    const textarea = screen.getByPlaceholderText('What should this quick agent do?');
    fireEvent.change(textarea, { target: { value: 'Fix the login bug' } });
    const startBtn = screen.getByText('Start Agent');
    expect(startBtn).not.toBeDisabled();
  });

  it('calls spawnQuickAgent and closes dialog on submit', async () => {
    const { mockSpawnQuickAgent, mockCloseDialog, mockSetActiveProject, mockSetExplorerTab } = setupStores();
    render(<QuickAgentDialog />);

    const textarea = screen.getByPlaceholderText('What should this quick agent do?');
    fireEvent.change(textarea, { target: { value: 'Fix the login bug' } });
    fireEvent.click(screen.getByText('Start Agent'));

    expect(mockCloseDialog).toHaveBeenCalled();
    expect(mockSetActiveProject).toHaveBeenCalledWith('proj-1');
    expect(mockSetExplorerTab).toHaveBeenCalledWith('agents', 'proj-1');
    expect(mockSpawnQuickAgent).toHaveBeenCalledWith(
      'proj-1',
      '/project1',
      'Fix the login bug',
      'default',
      undefined, // no parent
      'claude-code', // orchestrator
      undefined, // freeAgentMode
    );
  });

  it('closes dialog on Cancel click', () => {
    const { mockCloseDialog } = setupStores();
    render(<QuickAgentDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('closes dialog on Escape key', () => {
    const { mockCloseDialog } = setupStores();
    render(<QuickAgentDialog />);
    fireEvent.keyDown(screen.getByText('New Quick Agent').closest('div')!, { key: 'Escape' });
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('closes dialog on backdrop click', () => {
    const { mockCloseDialog } = setupStores();
    render(<QuickAgentDialog />);
    // Click the backdrop (outermost fixed div)
    const backdrop = screen.getByText('New Quick Agent').closest('.fixed');
    fireEvent.click(backdrop!);
    expect(mockCloseDialog).toHaveBeenCalled();
  });
});
