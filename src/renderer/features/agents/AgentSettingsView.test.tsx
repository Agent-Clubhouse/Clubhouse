import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { AgentSettingsView } from './AgentSettingsView';
import { useAgentSettingsPages, requestCloseAgentSettings, requestLeaveAgentSettings } from './agentSettingsPages';
import { useToastStore } from '../../stores/toastStore';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
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

let skillsProps: any;
vi.mock('./SkillsSection', () => ({
  SkillsSection: (props: any) => {
    skillsProps = props;
    return <div data-testid="skills-section" data-disabled={String(props.disabled)} />;
  },
}));

let capturedOnCreateFromPluginTemplate: ((entry: any) => void) | undefined;
vi.mock('./AgentTemplatesSection', () => ({
  AgentTemplatesSection: (props: any) => {
    capturedOnCreateFromPluginTemplate = props.onCreateFromPluginTemplate;
    return <div data-testid="agent-templates-section" data-disabled={String(props.disabled)} />;
  },
}));

let mcpProps: any;
vi.mock('./McpJsonSection', () => ({
  McpJsonSection: (props: any) => {
    mcpProps = props;
    return <div data-testid="mcp-json-section" data-disabled={String(props.disabled)} />;
  },
}));

let _capturedTemplateOnCreate: ((config: any) => void) | undefined;
let _capturedTemplateOnClose: (() => void) | undefined;
vi.mock('./TemplateConfigDialog', () => ({
  TemplateConfigDialog: (props: any) => {
    _capturedTemplateOnCreate = props.onCreate;
    _capturedTemplateOnClose = props.onClose;
    return (
      <div data-testid="template-config-dialog">
        <span data-testid="template-dialog-persona">{props.persona?.name}</span>
        <button data-testid="template-dialog-create" onClick={() => props.onCreate({
          persona: props.persona,
          name: props.persona.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          color: 'indigo',
          model: 'default',
          orchestrator: 'claude-code',
          useWorktree: true,
          freeAgentMode: false,
        })}>
          Create Agent
        </button>
        <button data-testid="template-dialog-close" onClick={props.onClose}>Cancel</button>
      </div>
    );
  },
}));

// NOTE: useModelOptions is deliberately NOT mocked. It fetches asynchronously via
// window.clubhouse.agent.getModelOptions and reports a `default`-only placeholder
// while in flight — mocking it away with a synchronous full list is what hid the
// "Sonnet loads as Custom..." bug. Tests drive the real hook through the IPC mock.
const MODEL_OPTION_LIST = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
];

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
    agentSettingsOpenFor: 'agent-1',
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
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({});
    window.clubhouse.agentSettings.readInstructions = vi.fn().mockResolvedValue('Agent instructions');
    window.clubhouse.agentSettings.saveInstructions = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.readPermissions = vi.fn().mockResolvedValue({ allow: ['Read(**)'] });
    window.clubhouse.agentSettings.savePermissions = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentSettings.previewMaterialization = vi.fn().mockResolvedValue(mockPreview);
    (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({});
    (window.clubhouse.agent as any).updateDurableConfig = vi.fn().mockResolvedValue(undefined);
    (window.clubhouse.agent as any).getModelOptions = vi.fn().mockResolvedValue(MODEL_OPTION_LIST);
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

    it('renders reload button', () => {
      renderSettings();
      expect(screen.getByRole('button', { name: 'Reload from disk' })).toBeInTheDocument();
    });
  });

  describe('running state', () => {
    it('shows one line with the Working state and Stop when running', () => {
      renderSettings({ status: 'running' });
      const line = screen.getByTestId('agent-settings-running');
      expect(line).toHaveTextContent('Working');
      expect(line).toHaveTextContent('Stop the agent to change these settings.');
    });

    it('stops the agent from the running line', () => {
      const killAgent = vi.fn().mockResolvedValue(undefined);
      useAgentStore.setState({ killAgent });
      renderSettings({ status: 'running' });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(killAgent).toHaveBeenCalledWith('agent-1');
    });

    it('does not show the running line when sleeping', () => {
      renderSettings({ status: 'sleeping' });
      expect(screen.queryByTestId('agent-settings-running')).not.toBeInTheDocument();
    });
  });

  describe('identity section', () => {
    it('renders the sentence-case Identity heading', () => {
      renderSettings();
      expect(screen.getByRole('heading', { name: 'Identity' })).toBeInTheDocument();
    });

    it('edits the name in place', () => {
      renderSettings();
      expect(screen.getByLabelText('Name')).toHaveValue('bold-falcon');
    });

    it('saves a new name on blur', async () => {
      const updateAgent = vi.fn().mockResolvedValue(undefined);
      useAgentStore.setState({ updateAgent });
      renderSettings();
      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'calm-heron' } });
      fireEvent.blur(input);
      await waitFor(() => expect(updateAgent).toHaveBeenCalledWith('agent-1', { name: 'calm-heron' }, '/project'));
    });

    it('restores the name on Escape without saving', () => {
      const updateAgent = vi.fn();
      useAgentStore.setState({ updateAgent });
      renderSettings();
      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'calm-heron' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(input).toHaveValue('bold-falcon');
      expect(updateAgent).not.toHaveBeenCalled();
    });

    it('renders color picker', () => {
      renderSettings();
      expect(screen.getByRole('radiogroup', { name: 'Color' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveAttribute('aria-checked', 'true');
    });

    it('renders model selector', () => {
      renderSettings();
      expect(screen.getByLabelText('Model', { selector: '#agent-settings-model' })).toBeInTheDocument();
    });

    it('disables the name when running', () => {
      renderSettings({ status: 'running' });
      expect(screen.getByLabelText('Name')).toBeDisabled();
    });
  });

  describe('classic single page', () => {
    it('has no uppercase labels', () => {
      const { container } = renderSettings();
      expect(container.querySelector('.uppercase')).toBeNull();
    });

    it('stacks every section on one page', async () => {
      renderSettings();
      expect(await screen.findByTestId('skills-section')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Quick agents' })).toBeInTheDocument();
      expect(screen.queryByTestId('agent-settings-nav')).not.toBeInTheDocument();
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

    it('renders free agent mode as a switch', () => {
      renderSettings();
      expect(screen.getByRole('switch', { name: 'Free Agent Mode' })).toBeInTheDocument();
    });

    it('does not render a Structured Mode toggle, even with the legacy experimental flag set', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ structuredMode: true });
      renderSettings();
      expect(await screen.findByTestId('agent-settings-free-agent-mode')).toBeInTheDocument();
      expect(screen.queryByTestId('structured-mode-field')).not.toBeInTheDocument();
      expect(screen.queryByText('Structured Mode')).not.toBeInTheDocument();
    });

    it('shows shared settings info note', () => {
      renderSettings();
      expect(screen.getByText(/Skills, agent definitions and MCP settings live in the agent worktree/)).toBeInTheDocument();
    });
  });

  describe('orchestrator dropdown', () => {
    // Make sure two orchestrators are enabled so the <select> renders (the
    // single-orchestrator path shows a static label instead).
    function setupMultiOrch() {
      useOrchestratorStore.setState({
        enabled: ['claude-code', 'github-copilot'],
        allOrchestrators: [
          {
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
          },
          {
            id: 'github-copilot',
            displayName: 'GitHub Copilot',
            shortName: 'GHCP',
            capabilities: { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false },
            conventions: {
              configDir: '.github',
              localInstructionsFile: '.github/copilot-instructions.md',
              legacyInstructionsFile: '.github/copilot-instructions.md',
              mcpConfigFile: 'mcp.json',
              skillsDir: 'skills',
              agentTemplatesDir: 'agents',
              localSettingsFile: 'settings.json',
            },
          },
        ],
      } as any);
    }

    it('patches the agent store after change so the controlled dropdown reflects the new value (regression: dropdown stuck on previous value)', async () => {
      setupMultiOrch();
      renderSettings({ orchestrator: 'claude-code' });

      const select = screen.getByDisplayValue('Claude Code') as HTMLSelectElement;
      expect(select.value).toBe('claude-code');

      fireEvent.change(select, { target: { value: 'github-copilot' } });

      // IPC persistence happens
      await waitFor(() => {
        expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(
          '/project',
          'agent-1',
          { orchestrator: 'github-copilot', model: 'default' },
        );
      });

      // CRITICAL: the in-memory store is patched in the same handler. The
      // parent panel re-derives the `agent` prop from this store, so without
      // this update the dropdown shows the old orchestrator even though the
      // next agent start uses the new one.
      await waitFor(() => {
        expect(useAgentStore.getState().agents['agent-1'].orchestrator).toBe('github-copilot');
      });
    });

    it('resets the model along with the CLI, in the store and the Model select (#2593)', async () => {
      setupMultiOrch();
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ model: 'sonnet' });
      renderSettings({ orchestrator: 'claude-code', model: 'sonnet' });
      const model = screen.getByLabelText('Model', { selector: '#agent-settings-model' }) as HTMLSelectElement;
      await waitFor(() => expect(model.value).toBe('sonnet'));
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'github-copilot' } });
      await waitFor(() => expect(useAgentStore.getState().agents['agent-1'].model).toBeUndefined());
      await waitFor(() => expect(model.value).toBe('default'));
    });

    it('warns before changing the CLI of an agent with a saved session (#2593)', async () => {
      setupMultiOrch();
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ lastSessionId: 's1' });
      renderSettings({ orchestrator: 'claude-code' });
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'github-copilot' } });
      await screen.findByText(/starts a new session on GitHub Copilot the next time it wakes/);
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
      expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('claude-code');

      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'github-copilot' } });
      fireEvent.click(await screen.findByTestId('confirm-destructive-confirm'));
      await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(
        '/project', 'agent-1', { orchestrator: 'github-copilot', model: 'default' },
      ));
    });

    it('labels the CLI picker "Runs on" (#2233)', () => {
      setupMultiOrch();
      renderSettings({ orchestrator: 'claude-code' });
      expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('claude-code');
      expect(screen.queryByLabelText('Orchestrator')).toBeNull();
    });
  });

  describe('runtime override', () => {
    it('is hidden when the experimental Chat flag is off', async () => {
      renderSettings();
      expect(await screen.findByTestId('agent-settings-free-agent-mode')).toBeInTheDocument();
      await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
      expect(screen.queryByLabelText('Runtime')).not.toBeInTheDocument();
    });

    it('shows Provider default when no override is saved', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: true });
      window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
      renderSettings();
      const select = await screen.findByLabelText('Runtime') as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Provider default', 'Chat', 'CLI']);
    });

    it('loads and persists the override, using null for Provider default', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: true });
      window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ runtimeMode: 'terminal' });
      const updateMock = vi.fn().mockResolvedValue(undefined);
      (window.clubhouse.agent as any).updateDurableConfig = updateMock;
      renderSettings();

      const select = await screen.findByLabelText('Runtime') as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe('terminal'));

      fireEvent.change(select, { target: { value: 'chat' } });
      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith('/project', 'agent-1', { runtimeMode: 'chat' });
      });

      fireEvent.change(select, { target: { value: '' } });
      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith('/project', 'agent-1', { runtimeMode: null });
      });
    });

    it('is disabled with a tooltip while the agent is running', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: true });
      window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
      renderSettings({ status: 'running' });
      const select = await screen.findByLabelText('Runtime');
      expect(select).toBeDisabled();
      expect(select).toHaveAttribute('title', 'Stop the agent to change this');
    });
  });

  describe('persona dropdown', () => {
    it('renders with "Project default" selected when agent has no persona', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({});
      renderSettings();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Project default')).toBeInTheDocument();
      });
    });

    it('loads the agent\'s current persona', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ persona: 'qa' });
      renderSettings();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Quality Assurance')).toBeInTheDocument();
      });
    });

    it('persists the new persona via updateDurableConfig (independent of override)', async () => {
      // No clubhouseModeOverride manipulation — persona should be settable regardless.
      const updateMock = vi.fn().mockResolvedValue(undefined);
      (window.clubhouse.agent as any).updateDurableConfig = updateMock;
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({});
      renderSettings();
      const select = await screen.findByDisplayValue('Project default') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'qa' } });

      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith('/project', 'agent-1', { persona: 'qa' });
      });
    });

    it('clears the persona when set back to "Project default"', async () => {
      const updateMock = vi.fn().mockResolvedValue(undefined);
      (window.clubhouse.agent as any).updateDurableConfig = updateMock;
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ persona: 'qa' });
      renderSettings();
      const select = await screen.findByDisplayValue('Quality Assurance') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '' } });

      await waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith('/project', 'agent-1', { persona: '' });
      });
    });
  });

  describe('clubhouse mode', () => {
    beforeEach(() => {
      useClubhouseModeStore.setState({
        enabled: true,
        isEnabledForProject: () => true,
      });
    });

    it('shows a Clubhouse Mode section when active', () => {
      renderSettings();
      expect(screen.getByRole('heading', { name: 'Clubhouse Mode' })).toBeInTheDocument();
    });

    it('shows managed mode message when no override', () => {
      renderSettings();
      expect(screen.getByText(/settings come from project defaults/)).toBeInTheDocument();
    });

    it('shows local override switch', () => {
      renderSettings();
      expect(screen.getByRole('switch', { name: 'Local overrides' })).toBeInTheDocument();
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

    it('shows the wildcard settings form when managed', async () => {
      (window.clubhouse.agentSettings as any).getAgentWildcards = vi.fn().mockResolvedValue({
        agentName: 'bold-falcon',
        standbyBranch: 'bold-falcon/standby',
        agentPath: '.clubhouse/agents/bold-falcon/',
        sourceControlProvider: { override: null, resolved: 'github' },
        buildCommand: { override: null, resolved: 'npm run build' },
        testCommand: { override: null, resolved: 'npm test' },
        lintCommand: { override: null, resolved: 'npm run lint' },
        mission: { override: null, projectDefault: null, resolved: null },
        persona: { override: null, projectDefault: null, resolved: null },
        missions: [],
        personas: [],
      });
      renderSettings();
      expect(await screen.findByText('Wildcards')).toBeInTheDocument();
      expect(screen.getByText('@@BuildCommand')).toBeInTheDocument();
      expect(screen.getByText('@@Mission')).toBeInTheDocument();
    });

    it('shows materialization preview behind the collapsible toggle when managed', async () => {
      renderSettings();
      fireEvent.click(await screen.findByText('Show resolved preview'));
      expect(await screen.findByText('Resolved instructions')).toBeInTheDocument();
      expect(screen.getByText('You are bold-falcon.')).toBeInTheDocument();
    });

    it('shows resolved permissions in preview', async () => {
      renderSettings();
      fireEvent.click(await screen.findByText('Show resolved preview'));
      expect(await screen.findByText('Resolved permissions')).toBeInTheDocument();
    });

    it('shows managed skills in preview', async () => {
      renderSettings();
      fireEvent.click(await screen.findByText('Show resolved preview'));
      expect(await screen.findByText('Managed skills')).toBeInTheDocument();
      expect(screen.getByText('mission, review')).toBeInTheDocument();
    });

    it('shows managed agent templates in preview', async () => {
      renderSettings();
      fireEvent.click(await screen.findByText('Show resolved preview'));
      expect(await screen.findByText('Managed agent definitions')).toBeInTheDocument();
      expect(screen.getByText('researcher')).toBeInTheDocument();
    });

    it('shows override message when override is enabled', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({
        clubhouseModeOverride: true,
      });

      renderSettings();
      await waitFor(() => {
        expect(screen.getByText(/this agent keeps its own instructions/)).toBeInTheDocument();
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

    it('toggles override on switch click', async () => {
      renderSettings();
      fireEvent.click(await screen.findByRole('switch', { name: 'Local overrides' }));

      await waitFor(() => {
        expect((window.clubhouse.agent as any).updateDurableConfig).toHaveBeenCalledWith(
          '/project', 'agent-1', { clubhouseModeOverride: true },
        );
      });
    });

    it('shows the personalize info note when managed', () => {
      renderSettings();
      expect(screen.getByText(/Personalize this agent with the wildcard values/)).toBeInTheDocument();
    });
  });

  describe('clubhouse mode banner not shown when off', () => {
    it('does not show clubhouse banner when mode is off', () => {
      useClubhouseModeStore.setState({
        enabled: false,
        isEnabledForProject: () => false,
      });
      renderSettings();
      expect(screen.queryByRole('heading', { name: 'Clubhouse Mode' })).not.toBeInTheDocument();
    });
  });

  describe('shell in worktree', () => {
    it('renders the Shell in worktree row', () => {
      renderSettings();
      expect(screen.getByText('Shell in worktree')).toBeInTheDocument();
      expect(screen.queryByTestId('utility-terminal')).not.toBeInTheDocument();
    });

    it('expands terminal on click', () => {
      renderSettings();
      fireEvent.click(screen.getByText('Shell in worktree'));
      expect(screen.getByTestId('utility-terminal')).toBeInTheDocument();
    });
  });

  describe('custom model', () => {
    it('shows Custom option in model selector', () => {
      renderSettings();
      const modelSelect = screen.getByLabelText('Model', { selector: '#agent-settings-model' }) as HTMLSelectElement;
      const options = Array.from(modelSelect.querySelectorAll('option'));
      expect(options.find((o) => o.value === 'custom')).toBeDefined();
    });

    it('reveals text input when Custom is selected', () => {
      renderSettings();
      const modelSelect = screen.getByLabelText('Model', { selector: '#agent-settings-model' }) as HTMLSelectElement;
      fireEvent.change(modelSelect, { target: { value: 'custom' } });
      expect(screen.getByPlaceholderText('e.g. claude-opus-4-6')).toBeInTheDocument();
    });

    it('loads non-standard persisted model as Custom with value in text input', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({
        model: 'my-special-model-v3',
      });
      renderSettings();
      await waitFor(() => {
        const modelSelect = screen.getByDisplayValue('Custom...') as HTMLSelectElement;
        expect(modelSelect.value).toBe('custom');
      });
      expect(screen.getByDisplayValue('my-special-model-v3')).toBeInTheDocument();
    });

    it('loads a known persisted model as itself, not Custom', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ model: 'sonnet' });
      renderSettings();
      await waitFor(() => {
        expect(screen.getByDisplayValue('Sonnet')).toBeInTheDocument();
      });
      expect(screen.queryByDisplayValue('Custom...')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('e.g. claude-opus-4-6')).not.toBeInTheDocument();
    });

    it('does not latch a known model as Custom when the option list resolves last', async () => {
      // Regression: the model option list arrives after the durable config. If the
      // known-vs-custom split runs against the in-flight `default`-only placeholder,
      // `sonnet` is mislabelled "Custom..." and never re-corrected.
      let releaseOptions!: (opts: typeof MODEL_OPTION_LIST) => void;
      (window.clubhouse.agent as any).getModelOptions = vi.fn().mockReturnValue(
        new Promise((resolve) => { releaseOptions = resolve; }),
      );
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ model: 'sonnet' });

      renderSettings();
      // Config has landed while the option list is still loading.
      await waitFor(() => {
        expect((window.clubhouse.agent as any).getDurableConfig).toHaveBeenCalled();
      });
      expect(screen.queryByDisplayValue('Custom...')).not.toBeInTheDocument();

      releaseOptions(MODEL_OPTION_LIST);
      await waitFor(() => {
        expect(screen.getByDisplayValue('Sonnet')).toBeInTheDocument();
      });
      expect(screen.queryByDisplayValue('Custom...')).not.toBeInTheDocument();
    });

    it('still classifies a genuinely unknown model as Custom once options load', async () => {
      let releaseOptions!: (opts: typeof MODEL_OPTION_LIST) => void;
      (window.clubhouse.agent as any).getModelOptions = vi.fn().mockReturnValue(
        new Promise((resolve) => { releaseOptions = resolve; }),
      );
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ model: 'claude-opus-4-6' });

      renderSettings();
      await waitFor(() => {
        expect((window.clubhouse.agent as any).getDurableConfig).toHaveBeenCalled();
      });
      releaseOptions(MODEL_OPTION_LIST);
      await waitFor(() => {
        expect(screen.getByDisplayValue('Custom...')).toBeInTheDocument();
      });
      expect(screen.getByDisplayValue('claude-opus-4-6')).toBeInTheDocument();
    });

    it('fetches model options for the agent own orchestrator', async () => {
      renderSettings({ orchestrator: 'codex-cli' });
      await waitFor(() => {
        expect((window.clubhouse.agent as any).getModelOptions).toHaveBeenCalledWith('/project', 'codex-cli');
      });
    });

    it('persists custom model on blur', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      (window.clubhouse.agent as any).updateDurableConfig = mockUpdate;
      renderSettings();
      const modelSelect = screen.getByLabelText('Model', { selector: '#agent-settings-model' }) as HTMLSelectElement;
      fireEvent.change(modelSelect, { target: { value: 'custom' } });
      const customInput = screen.getByPlaceholderText('e.g. claude-opus-4-6');
      fireEvent.change(customInput, { target: { value: 'claude-opus-4-6' } });
      fireEvent.blur(customInput);
      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('/project', 'agent-1', { model: 'claude-opus-4-6' });
      });
    });

    it('shows Custom option in QAD model selector', async () => {
      renderSettings();
      const qadModelSelect = await screen.findByLabelText('Model', { selector: '#agent-settings-qad-model' }) as HTMLSelectElement;
      const options = Array.from(qadModelSelect.querySelectorAll('option'));
      expect(options.find((o) => o.value === 'custom')).toBeDefined();
    });

    it('loads non-standard QAD default model as Custom', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({
        quickAgentDefaults: { defaultModel: 'exotic-model-7b' },
      });
      renderSettings();
      await waitFor(() => {
        expect(screen.getByDisplayValue('exotic-model-7b')).toBeInTheDocument();
      });
    });
  });

  describe('new chrome pages', () => {
    beforeEach(() => {
      useChromeFlagStore.setState({ enabled: true });
      useToastStore.setState({ toasts: [] });
    });
    afterEach(() => {
      useChromeFlagStore.setState({ enabled: false });
    });

    const visiblePage = () => screen.getAllByTestId(/^agent-settings-page-/).filter((el) => !el.hidden);

    it('has no header and opens on General', () => {
      renderSettings();
      expect(screen.queryByTitle('Back')).not.toBeInTheDocument();
      expect(visiblePage().map((el) => el.dataset.testid)).toEqual(['agent-settings-page-general']);
      expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    });

    it('shows the page the sidebar selects and keeps the others mounted but hidden', async () => {
      renderSettings();
      act(() => useAgentSettingsPages.getState().setPage('skills'));
      expect(visiblePage().map((el) => el.dataset.testid)).toEqual(['agent-settings-page-skills']);
      expect(screen.getByTestId('skills-section')).toBeVisible();
      expect(screen.getByLabelText('Name')).not.toBeVisible();
    });

    it('keeps edits when switching pages', async () => {
      renderSettings();
      act(() => useAgentSettingsPages.getState().setPage('instructions'));
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Kept' } });
      act(() => useAgentSettingsPages.getState().setPage('general'));
      act(() => useAgentSettingsPages.getState().setPage('instructions'));
      expect(screen.getByLabelText('Instructions')).toHaveValue('Kept');
    });

    it('resets to General when another agent opens', () => {
      useAgentSettingsPages.getState().setPage('permissions');
      renderSettings();
      expect(useAgentSettingsPages.getState().page).toBe('general');
    });

    it('collects text edits in one save bar and marks the dirty pages', async () => {
      renderSettings();
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'New instructions' } });
      fireEvent.change(await screen.findByLabelText('Allowed tools, one per line', { selector: '#agent-settings-perm-allow' }), { target: { value: 'Read(**)\nEdit(**)' } });

      const bar = screen.getByTestId('agent-settings-save-bar');
      expect(bar).toHaveTextContent('Unsaved changes to instructions and permissions');
      expect(useAgentSettingsPages.getState().dirtyPages).toEqual(['instructions', 'permissions']);

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(window.clubhouse.agentSettings.saveInstructions).toHaveBeenCalledWith(
          '/project/.clubhouse/agents/bold-falcon', 'New instructions', '/project',
        );
        expect(window.clubhouse.agentSettings.savePermissions).toHaveBeenCalledWith(
          '/project/.clubhouse/agents/bold-falcon', { allow: ['Read(**)', 'Edit(**)'], deny: undefined }, '/project',
        );
      });
      await waitFor(() => expect(screen.queryByTestId('agent-settings-save-bar')).not.toBeInTheDocument());
      expect(useAgentSettingsPages.getState().dirtyPages).toEqual([]);
    });

    it('keeps going after a failed save, says which saved, and leaves the bar usable', async () => {
      window.clubhouse.agentSettings.saveInstructions = vi.fn().mockRejectedValue(new Error('EACCES'));
      renderSettings();
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Nope' } });
      fireEvent.change(await screen.findByLabelText('Allowed tools, one per line', { selector: '#agent-settings-perm-allow' }), { target: { value: 'Edit(**)' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(window.clubhouse.agentSettings.savePermissions).toHaveBeenCalled());
      await waitFor(() => {
        expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Saved permissions. Couldn't save instructions."]);
      });
      expect(screen.getByTestId('agent-settings-save-bar')).toHaveTextContent('Unsaved changes to instructions');
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Discard' })).not.toBeDisabled();
    });

    it('discards text edits back to what was loaded', async () => {
      renderSettings();
      const editor = await screen.findByLabelText('Instructions');
      fireEvent.change(editor, { target: { value: 'Scratch' } });
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(editor).toHaveValue('Agent instructions');
      expect(screen.queryByTestId('agent-settings-save-bar')).not.toBeInTheDocument();
      expect(window.clubhouse.agentSettings.saveInstructions).not.toHaveBeenCalled();
    });

    it('saves and discards .mcp.json edits through the bar', async () => {
      renderSettings();
      await screen.findByTestId('mcp-json-section');
      const handle = { save: vi.fn().mockResolvedValue(undefined), discard: vi.fn() };
      act(() => {
        mcpProps.onRegisterSave(handle);
        mcpProps.onDirtyChange(true);
      });
      expect(screen.getByTestId('agent-settings-save-bar')).toHaveTextContent('Unsaved changes to MCP servers');
      expect(useAgentSettingsPages.getState().dirtyPages).toEqual(['mcp']);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(handle.save).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(handle.discard).toHaveBeenCalled();
    });

    it('marks a page with an open skill editor without adding it to the bar', async () => {
      renderSettings();
      await screen.findByTestId('skills-section');
      act(() => skillsProps.onDirtyChange(true));
      expect(useAgentSettingsPages.getState().dirtyPages).toEqual(['skills']);
      expect(screen.queryByTestId('agent-settings-save-bar')).not.toBeInTheDocument();
    });

    it('saves quick agent defaults from the save bar', async () => {
      renderSettings();
      fireEvent.change(await screen.findByLabelText('Extra instructions'), { target: { value: 'Be brief.' } });
      expect(screen.getByTestId('agent-settings-save-bar')).toHaveTextContent('quick agent defaults');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect((window.clubhouse.agent as any).updateDurableConfig).toHaveBeenCalledWith(
          '/project', 'agent-1', { quickAgentDefaults: { systemPrompt: 'Be brief.' } },
        );
      });
    });

    it('asks before leaving with unsaved edits', async () => {
      const closeAgentSettings = vi.fn();
      useAgentStore.setState({ closeAgentSettings });
      renderSettings();
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Unsaved' } });

      act(() => requestCloseAgentSettings());
      expect(closeAgentSettings).not.toHaveBeenCalled();
      expect(await screen.findByText('Leave with unsaved changes?')).toBeInTheDocument();
      expect(screen.getByText('Your changes to instructions will be lost.')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
      expect(closeAgentSettings).not.toHaveBeenCalled();

      act(() => requestCloseAgentSettings());
      fireEvent.click(await screen.findByTestId('confirm-destructive-confirm'));
      expect(closeAgentSettings).toHaveBeenCalled();
    });

    it('runs the pending action after confirming, so the other agent opens', async () => {
      const closeAgentSettings = vi.fn();
      const next = vi.fn();
      useAgentStore.setState({ closeAgentSettings, agentSettingsOpenFor: 'agent-1' });
      renderSettings();
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Unsaved' } });
      act(() => requestLeaveAgentSettings(next));
      expect(next).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId('confirm-destructive-confirm'));
      expect(closeAgentSettings).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('closes at once when nothing is unsaved', () => {
      const closeAgentSettings = vi.fn();
      useAgentStore.setState({ closeAgentSettings });
      renderSettings();
      act(() => requestCloseAgentSettings());
      expect(closeAgentSettings).toHaveBeenCalled();
    });

    it('discards edits to managed files when local overrides are turned off', async () => {
      useClubhouseModeStore.setState({ enabled: true, isEnabledForProject: () => true });
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ clubhouseModeOverride: true });
      renderSettings();
      const toggle = await screen.findByRole('switch', { name: 'Local overrides' });
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
      fireEvent.change(await screen.findByLabelText('Instructions'), { target: { value: 'Unsaved' } });
      fireEvent.change(screen.getByLabelText('Extra instructions'), { target: { value: 'Kept' } });

      fireEvent.click(toggle);
      await waitFor(() => expect(screen.getByTestId('agent-settings-save-bar')).toHaveTextContent('Unsaved changes to quick agent defaults'));
      expect(screen.getByTestId('agent-settings-save-bar')).not.toHaveTextContent('instructions and');
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        'Discarded unsaved changes to instructions. Clubhouse Mode manages them now.',
      ]);
    });

    it('shows the launch wrapper states as plain words', async () => {
      (window.clubhouse.project as any).readMcpCatalog = vi.fn().mockResolvedValue([
        { id: 'fs', name: 'Filesystem', command: 'fs' },
      ]);
      renderSettings();
      act(() => useAgentSettingsPages.getState().setPage('mcp'));
      const wrapper = await screen.findByTestId('agent-settings-launch-wrapper');
      expect(wrapper).toHaveTextContent('Launch wrapper');
      expect(wrapper).toHaveTextContent('Filesystem');
      expect(wrapper.querySelector('.uppercase')).toBeNull();
    });

    it('points managed pages back to General', async () => {
      useClubhouseModeStore.setState({ enabled: true, isEnabledForProject: () => true });
      renderSettings();
      act(() => useAgentSettingsPages.getState().setPage('skills'));
      const page = screen.getByTestId('agent-settings-page-skills');
      expect(within(page).getByTestId('agent-settings-managed')).toBeInTheDocument();
      fireEvent.click(within(page).getByRole('button', { name: /Turn on local overrides in General/ }));
      expect(useAgentSettingsPages.getState().page).toBe('general');
    });

    it('opens the shell from the store and hides its row while closed', () => {
      renderSettings();
      expect(screen.getByTestId('agent-settings-shell')).toHaveClass('hidden');
      act(() => useAgentSettingsPages.getState().setShellOpen(true));
      expect(screen.getByTestId('agent-settings-shell')).not.toHaveClass('hidden');
      expect(screen.getByTestId('utility-terminal')).toBeInTheDocument();
    });

    it('takes sidebar counts from the sections and clears them under Clubhouse Mode', async () => {
      renderSettings();
      await screen.findByTestId('skills-section');
      act(() => {
        skillsProps.onCountChange(2);
        mcpProps.onCountChange(3);
      });
      expect(useAgentSettingsPages.getState().counts).toEqual({ skills: 2, mcp: 3 });
    });

    it('clears counts when Clubhouse Mode manages the agent', () => {
      useAgentSettingsPages.getState().setCount('skills', 4);
      useClubhouseModeStore.setState({ enabled: true, isEnabledForProject: () => true });
      renderSettings();
      expect(useAgentSettingsPages.getState().counts).toEqual({});
    });
  });

  describe('plugin template → TemplateConfigDialog flow', () => {
    const mockPluginTemplate = {
      pluginId: 'test-plugin',
      pluginName: 'Test Plugin',
      template: {
        name: 'Code Reviewer',
        description: 'Reviews pull requests',
        promptContent: '# Code Reviewer\nYou review code.',
        skills: { review: '# Review Skill\nDo reviews.' },
        mcpServers: {
          'review-server': { command: 'node', args: ['review-server.js'] },
        },
      },
    };

    beforeEach(() => {
      capturedOnCreateFromPluginTemplate = undefined;
      _capturedTemplateOnCreate = undefined;
      _capturedTemplateOnClose = undefined;
      (window.clubhouse.agent as any).createDurable = vi.fn().mockResolvedValue({
        id: 'new-agent-1',
        name: 'code-reviewer',
        color: 'indigo',
        worktreePath: '/project/.clubhouse/agents/code-reviewer',
        createdAt: new Date().toISOString(),
      });
      window.clubhouse.agentSettings.saveInstructions = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.agentSettings.writeSkillContent = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.agentSettings.readMcpRawJson = vi.fn().mockResolvedValue('{"mcpServers":{}}');
      window.clubhouse.agentSettings.writeMcpRawJson = vi.fn().mockResolvedValue({ ok: true });
      useAgentStore.setState({
        loadDurableAgents: vi.fn().mockResolvedValue(undefined),
      });
    });

    it('opens TemplateConfigDialog when plugin template Create is clicked', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      // No dialog initially
      expect(screen.queryByTestId('template-config-dialog')).not.toBeInTheDocument();

      // Simulate clicking Create on a plugin template
      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);

      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
        expect(screen.getByTestId('template-dialog-persona')).toHaveTextContent('Code Reviewer');
      });
    });

    it('closes dialog on cancel without creating agent', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-close'));
      await waitFor(() => {
        expect(screen.queryByTestId('template-config-dialog')).not.toBeInTheDocument();
      });
      expect((window.clubhouse.agent as any).createDurable).not.toHaveBeenCalled();
    });

    it('creates durable agent with config from dialog', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-create'));

      await waitFor(() => {
        expect((window.clubhouse.agent as any).createDurable).toHaveBeenCalledWith(
          '/project', 'code-reviewer', 'indigo', undefined, true,
          'claude-code', undefined, undefined, undefined,
        );
      });
    });

    it('writes plugin template instructions to new agent worktree', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-create'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.saveInstructions).toHaveBeenCalledWith(
          '/project/.clubhouse/agents/code-reviewer',
          '# Code Reviewer\nYou review code.',
          '/project',
        );
      });
    });

    it('injects plugin template skills into new agent', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-create'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeSkillContent).toHaveBeenCalledWith(
          '/project/.clubhouse/agents/code-reviewer',
          'review',
          '# Review Skill\nDo reviews.',
          '/project',
        );
      });
    });

    it('injects plugin template MCP servers into new agent mcp.json', async () => {
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-create'));

      await waitFor(() => {
        expect(window.clubhouse.agentSettings.writeMcpRawJson).toHaveBeenCalledWith(
          '/project/.clubhouse/agents/code-reviewer',
          expect.stringContaining('"review-server"'),
          '/project',
        );
      });
    });

    it('refreshes agent list after creating from plugin template', async () => {
      const loadDurableAgents = vi.fn().mockResolvedValue(undefined);
      useAgentStore.setState({ loadDurableAgents });
      renderSettings();
      await waitFor(() => {
        expect(capturedOnCreateFromPluginTemplate).toBeDefined();
      });

      capturedOnCreateFromPluginTemplate!(mockPluginTemplate);
      await waitFor(() => {
        expect(screen.getByTestId('template-config-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('template-dialog-create'));

      await waitFor(() => {
        expect(loadDurableAgents).toHaveBeenCalledWith('proj-1', '/project');
      });
    });
  });
});
