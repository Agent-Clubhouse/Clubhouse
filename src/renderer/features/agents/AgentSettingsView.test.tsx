import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { AgentSettingsView } from './AgentSettingsView';
import type { Agent, MaterializationPreview } from '../../../shared/types';

// Mock heavy child components
vi.mock('../../components/SettingsMonacoEditor', () => ({
  SettingsMonacoEditor: ({ value, onChange, readOnly }: any) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  ),
}));

vi.mock('./UtilityTerminal', () => ({
  UtilityTerminal: () => <div data-testid="utility-terminal" />,
}));

vi.mock('../../components/ImageCropDialog', () => ({
  ImageCropDialog: () => <div data-testid="image-crop-dialog" />,
}));

vi.mock('./SkillsSection', () => ({
  SkillsSection: (props: any) => <div data-testid="skills-section" data-disabled={String(props.disabled)} />,
}));

vi.mock('./AgentTemplatesSection', () => ({
  AgentTemplatesSection: (props: any) => <div data-testid="agent-templates-section" data-disabled={String(props.disabled)} />,
}));

vi.mock('./McpJsonSection', () => ({
  McpJsonSection: (props: any) => <div data-testid="mcp-json-section" data-disabled={String(props.disabled)} />,
}));

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({
    options: [
      { id: 'default', label: 'Default' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ],
    loading: false,
  }),
}));

const defaultAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'sleeping',
  color: 'indigo',
  worktreePath: '/project/.clubhouse/agents/bold-falcon',
};

const mockPreview: MaterializationPreview = {
  instructions: 'You are bold-falcon.',
  permissions: { allow: ['Read(**)', 'Edit(**)'], deny: ['WebFetch'] },
  mcpJson: '{"mcpServers": {}}',
  skills: ['mission', 'review'],
  agentTemplates: ['researcher'],
};

function resetStores() {
  useAgentStore.setState({
    agents: { 'agent-1': defaultAgent },
    activeAgentId: 'agent-1',
    agentIcons: {},
    closeAgentSettings: vi.fn(),
    updateAgent: vi.fn(),
    pickAgentIcon: vi.fn().mockResolvedValue(null),
    saveAgentIcon: vi.fn(),
    removeAgentIcon: vi.fn(),
  });
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'my-app', path: '/project' }],
    activeProjectId: 'proj-1',
  });
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [{
      id: 'claude-code',
      displayName: 'Claude Code',
      shortName: 'CC',
      capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
      conventions: {
        configDir: '.claude',
        localInstructionsFile: 'CLAUDE.md',
        legacyInstructionsFile: 'CLAUDE.md',
        mcpConfigFile: '.mcp.json',
        skillsDir: 'skills',
        agentTemplatesDir: 'agents',
        localSettingsFile: 'settings.local.json',
      },
    }],
  });
  useClubhouseModeStore.setState({
    enabled: false,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    isEnabledForProject: () => false,
  });
}

function renderSettings(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...defaultAgent, ...agentOverrides };
  useAgentStore.setState({ agents: { [agent.id]: agent } });
  return render(<AgentSettingsView agent={agent} />);
}

describe('AgentSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();

    // Setup IPC mocks
    window.clubhouse.agentSettings.readInstructions = vi.fn().mockResolvedValue('Agent instructions');
    window.clubhouse.agentSettings.saveInstructions = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.readPermissions = vi.fn().mockResolvedValue({ allow: ['Read(**)'] });
    window.clubhouse.agentSettings.savePermissions = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.previewMaterialization = vi.fn().mockResolvedValue(mockPreview);
    (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({});
    (window.clubhouse.agent as any).updateDurableConfig = vi.fn().mockResolvedValue(undefined);
    (window.clubhouse.agent as any).getModelOptions = vi.fn().mockResolvedValue([{ id: 'default', label: 'Default' }]);
  });

  describe('header', () => {
    it('renders agent name', () => {
      renderSettings();
      // Agent name appears in both header and appearance section
      expect(screen.getAllByText('bold-falcon').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('renders back button', () => {
      renderSettings();
      expect(screen.getByTitle('Back')).toBeInTheDocument();
    });

    it('calls closeAgentSettings on back click', () => {
      const closeAgentSettings = vi.fn();
      useAgentStore.setState({ closeAgentSettings });
      renderSettings();
      fireEvent.click(screen.getByTitle('Back'));
      expect(closeAgentSettings).toHaveBeenCalled();
    });

    it('renders refresh button', () => {
      renderSettings();
      expect(screen.getByTitle('Refresh from disk')).toBeInTheDocument();
    });
  });

  describe('running state', () => {
    it('shows read-only banner when running', () => {
      renderSettings({ status: 'running' });
      expect(screen.getByText(/read-only while this agent is running/)).toBeInTheDocument();
    });

    it('does not show read-only banner when sleeping', () => {
      renderSettings({ status: 'sleeping' });
      expect(screen.queryByText(/read-only while this agent is running/)).not.toBeInTheDocument();
    });
  });

  describe('appearance section', () => {
    it('renders appearance heading', () => {
      renderSettings();
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    it('renders agent name with rename button', () => {
      renderSettings();
      expect(screen.getByText('Rename')).toBeInTheDocument();
    });

    it('shows rename input on Rename click', () => {
      renderSettings();
      fireEvent.click(screen.getByText('Rename'));
      expect(screen.getByDisplayValue('bold-falcon')).toBeInTheDocument();
    });

    it('renders color picker', () => {
      renderSettings();
      expect(screen.getByText('Color')).toBeInTheDocument();
    });

    it('renders model selector', () => {
      renderSettings();
      expect(screen.getByText('Model')).toBeInTheDocument();
    });

    it('disables rename when running', () => {
      renderSettings({ status: 'running' });
      expect(screen.getByText('Rename')).toBeDisabled();
    });
  });

  describe('tab switching', () => {
    it('renders Main Agent and Quick Agent tabs', () => {
      renderSettings();
      expect(screen.getByText('Main Agent')).toBeInTheDocument();
      expect(screen.getByText('Quick Agent')).toBeInTheDocument();
    });

    it('shows main tab content by default', async () => {
      renderSettings();
      await waitFor(() => {
        expect(screen.getByTestId('skills-section')).toBeInTheDocument();
      });
    });

    it('switches to quick agent tab', async () => {
      renderSettings();
      fireEvent.click(screen.getByText('Quick Agent'));
      expect(await screen.findByText('Quick Agent Defaults')).toBeInTheDocument();
    });
  });

  describe('main agent tab - editable mode', () => {
    it('renders instructions section', async () => {
      renderSettings();
      expect(await screen.findByText('Instructions')).toBeInTheDocument();
    });

    it('renders skills section', async () => {
      renderSettings();
      expect(await screen.findByTestId('skills-section')).toBeInTheDocument();
    });

    it('renders agent templates section', async () => {
      renderSettings();
      expect(await screen.findByTestId('agent-templates-section')).toBeInTheDocument();
    });

    it('renders MCP JSON section', async () => {
      renderSettings();
      expect(await screen.findByTestId('mcp-json-section')).toBeInTheDocument();
    });

    it('renders permissions section', async () => {
      renderSettings();
      expect(await screen.findByText('Permissions')).toBeInTheDocument();
    });

    it('renders free agent mode', () => {
      renderSettings();
      expect(screen.getByText('Free Agent Mode')).toBeInTheDocument();
    });

    it('shows shared settings info note', () => {
      renderSettings();
      expect(screen.getByText(/Skills, agent definitions, and MCP settings/)).toBeInTheDocument();
    });
  });

  describe('clubhouse mode', () => {
    beforeEach(() => {
      useClubhouseModeStore.setState({
        enabled: true,
        isEnabledForProject: () => true,
      });
    });

    it('shows clubhouse mode banner when active', () => {
      renderSettings();
      expect(screen.getByText(/Clubhouse Mode is active/)).toBeInTheDocument();
    });

    it('shows managed mode message when no override', () => {
      renderSettings();
      expect(screen.getByText(/managed from project defaults/)).toBeInTheDocument();
    });

    it('shows local override checkbox', () => {
      renderSettings();
      expect(screen.getByText('Enable local overrides')).toBeInTheDocument();
    });

    it('hides editable sections when managed by clubhouse', async () => {
      renderSettings();
      // When managed, these should not render
      await waitFor(() => {
        expect(screen.queryByTestId('skills-section')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-templates-section')).not.toBeInTheDocument();
        expect(screen.queryByTestId('mcp-json-section')).not.toBeInTheDocument();
      });
    });

    it('shows materialization preview when managed', async () => {
      renderSettings();
      expect(await screen.findByText('Resolved Instructions')).toBeInTheDocument();
      expect(screen.getByText('You are bold-falcon.')).toBeInTheDocument();
    });

    it('shows resolved permissions in preview', async () => {
      renderSettings();
      expect(await screen.findByText('Resolved Permissions')).toBeInTheDocument();
    });

    it('shows managed skills in preview', async () => {
      renderSettings();
      expect(await screen.findByText('Managed Skills')).toBeInTheDocument();
      expect(screen.getByText('mission')).toBeInTheDocument();
      expect(screen.getByText('review')).toBeInTheDocument();
    });

    it('shows managed agent templates in preview', async () => {
      renderSettings();
      expect(await screen.findByText('Managed Agent Templates')).toBeInTheDocument();
      expect(screen.getByText('researcher')).toBeInTheDocument();
    });

    it('shows override message when override is enabled', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({
        clubhouseModeOverride: true,
      });

      renderSettings();
      await waitFor(() => {
        expect(screen.getByText(/local overrides are enabled/)).toBeInTheDocument();
      });
    });

    it('shows editable sections when override is enabled', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({
        clubhouseModeOverride: true,
      });

      renderSettings();
      await waitFor(() => {
        expect(screen.getByTestId('skills-section')).toBeInTheDocument();
        expect(screen.getByTestId('agent-templates-section')).toBeInTheDocument();
        expect(screen.getByTestId('mcp-json-section')).toBeInTheDocument();
      });
    });

    it('toggles override on checkbox click', async () => {
      renderSettings();
      const checkbox = await screen.findByRole('checkbox', { name: /local overrides/i });
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect((window.clubhouse.agent as any).updateDurableConfig).toHaveBeenCalledWith(
          '/project', 'agent-1', { clubhouseModeOverride: true },
        );
      });
    });

    it('shows resolved info note when managed', () => {
      renderSettings();
      expect(screen.getByText(/resolved from project defaults/)).toBeInTheDocument();
    });
  });

  describe('clubhouse mode banner not shown when off', () => {
    it('does not show clubhouse banner when mode is off', () => {
      useClubhouseModeStore.setState({
        enabled: false,
        isEnabledForProject: () => false,
      });
      renderSettings();
      expect(screen.queryByText(/Clubhouse Mode is active/)).not.toBeInTheDocument();
    });
  });

  describe('utility terminal', () => {
    it('renders utility shell toggle', () => {
      renderSettings();
      expect(screen.getByText('Utility shell')).toBeInTheDocument();
    });

    it('expands terminal on click', () => {
      renderSettings();
      fireEvent.click(screen.getByText('Utility shell'));
      expect(screen.getByTestId('utility-terminal')).toBeInTheDocument();
    });
  });
});
