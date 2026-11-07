import { claudeContextWindowOptions } from '../../../shared/context-window';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { AgentSettingsView } from './AgentSettingsView';
import { useAgentSettingsPages, requestCloseAgentSettings, requestLeaveAgentSettings } from './agentSettingsPages';
import { useToastStore } from '../../stores/toastStore';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import type { Agent } from '../../../shared/types';

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

let mcpProps: any;
vi.mock('./McpJsonSection', () => ({
  McpJsonSection: (props: any) => {
    mcpProps = props;
    return <div data-testid="mcp-json-section" data-disabled={String(props.disabled)} />;
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
    (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({});
    (window.clubhouse.agent as any).updateDurableConfig = vi.fn().mockResolvedValue(undefined);
    (window.clubhouse.agent as any).getModelOptions = vi.fn().mockResolvedValue(MODEL_OPTION_LIST);
    (window.clubhouse.agent as any).getContextWindowOptions = vi.fn().mockResolvedValue({ configurable: false, state: 'unsupported', label: 'Context', reason: 'No context setting.' });
  });

  describe('context choice (#2660)', () => {
    it('awake: shows the saved next-start choice and reads no catalog', async () => {
      const read = (window.clubhouse.agent as any).getContextWindowOptions;
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ contextWindow: '500000' });
      renderSettings({ status: 'running' });
      await waitFor(() => expect(screen.getByTestId('agent-settings-context-saved').textContent).toBe('500K on the next start'));
      expect(read).not.toHaveBeenCalled();
    });

    it('awake with no choice: says the CLI decides, rather than Loading', async () => {
      renderSettings({ status: 'running' });
      await waitFor(() => expect(screen.getByTestId('agent-settings-context-saved').textContent).toBe('CLI default'));
    });

    it('asleep: offers the choices and saves one', async () => {
      (window.clubhouse.agent as any).getContextWindowOptions = vi.fn().mockResolvedValue(claudeContextWindowOptions('opus'));
      renderSettings({ status: 'sleeping' });
      const select = await screen.findByRole('combobox', { name: 'Working context' });
      fireEvent.change(select, { target: { value: '300000' } });
      await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), { contextWindow: '300000' }));
    });
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

    it('shows the builder instead of the file editors for a managed agent, and scrolls to a requested section', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ managed: { version: 1, blocks: [], skills: [], mcps: [] } });
      const getSetup = vi.spyOn(window.clubhouse.managed, 'getSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      useAgentSettingsPages.getState().setRequestedPage({ agentId: defaultAgent.id, page: 'preview' });
      try {
        const { rerender } = renderSettings();
        expect(await screen.findByTestId('managed-builder-instructions')).toBeInTheDocument();
        expect(screen.getByTestId('managed-builder-skills')).toBeInTheDocument();
        expect(screen.getByTestId('managed-builder-mcp')).toBeInTheDocument();
        expect(await screen.findByTestId('managed-preview')).toBeInTheDocument();
        expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument();
        expect(screen.queryByTestId('skills-section')).not.toBeInTheDocument();
        expect(screen.queryByTestId('mcp-json-section')).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Permissions' })).not.toBeInTheDocument();
        await waitFor(() => expect(scroll).toHaveBeenCalled());
        expect(scroll.mock.contexts[0]).toBe(screen.getByTestId('agent-settings-section-preview'));
        // A re-render with an equal agent doesn't load the setup again.
        const loads = getSetup.mock.calls.length;
        rerender(<AgentSettingsView agent={{ ...defaultAgent }} />);
        await act(async () => { await Promise.resolve(); });
        expect(getSetup.mock.calls.length).toBe(loads);
      } finally {
        useAgentSettingsPages.getState().setRequestedPage(null);
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });
  });

  describe('legacy configuration with Clubhouse-managed agents (#2901)', () => {
    it('offers no Clubhouse Mode, whatever an old config holds, and keeps the file editors (#2901)', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ clubhouseModeOverride: false });
      renderSettings();
      expect(await screen.findByTestId('managed-general-off')).toHaveTextContent('uses the instructions, skills and MCP config in its folder');
      expect(await screen.findByTestId('skills-section')).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Clubhouse Mode for this agent' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('managed-clubhouse-mode')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Persona')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Clubhouse Mode' })).not.toBeInTheDocument();
    });

    it('names the persona of an unmanaged agent, with the offer to switch, and keeps its file editors', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ persona: 'qa' });
      renderSettings();
      expect(await screen.findByTestId('managed-general-legacy')).toHaveTextContent('bold-falcon uses the Quality Assurance persona. Switch to managed keeps what it has now.');
      expect(screen.getByRole('button', { name: 'Switch to managed…' })).toBeInTheDocument();
      expect(await screen.findByTestId('skills-section')).toBeInTheDocument();
    });

    it('a plain agent gets the usual Setup text', async () => {
      renderSettings();
      expect(await screen.findByTestId('managed-general-off')).toHaveTextContent("uses the instructions, skills and MCP config in its folder");
      expect(screen.queryByTestId('managed-general-legacy')).not.toBeInTheDocument();
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
      expect(screen.getByText('Handle permissions using the configured Free agent permission mode.')).toBeInTheDocument();
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
      expect(screen.getByText(/Skills and MCP settings live in the agent worktree/)).toBeInTheDocument();
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
    it('is hidden when Chat is saved off', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: false });
      renderSettings();
      expect(await screen.findByTestId('agent-settings-free-agent-mode')).toBeInTheDocument();
      await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
      expect(screen.queryByLabelText('Runtime')).not.toBeInTheDocument();
    });

    it('shows Provider default when no override is saved', async () => {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({});
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

    it('keeps unknown runtime disabled after load failure and permits an explicit retry', async () => {
      window.clubhouse.agent.getDurableConfig = vi.fn().mockRejectedValue(new Error('read failed'));
      renderSettings();
      const retry = await screen.findByRole('button', { name: 'Retry loading runtime' });
      expect(screen.getByLabelText('Runtime')).toBeDisabled();
      vi.mocked(window.clubhouse.agent.getDurableConfig).mockResolvedValue({ runtimeMode: 'terminal' } as never);
      fireEvent.click(retry);
      await waitFor(() => expect(screen.getByLabelText('Runtime')).not.toBeDisabled());
      expect(screen.getByLabelText('Runtime')).toHaveValue('terminal');
    });

    it('ignores a previous target configuration arriving after the current target loads', async () => {
      let resolveOld!: (value: unknown) => void;
      window.clubhouse.agent.getDurableConfig = vi.fn().mockImplementation((_path, id) => id === 'agent-1'
        ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ runtimeMode: 'chat' }));
      const view = renderSettings();
      await waitFor(() => expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalled());
      const other = { ...defaultAgent, id: 'agent-2' };
      useAgentStore.setState({ agents: { [other.id]: other } });
      view.rerender(<AgentSettingsView agent={other} />);
      await waitFor(() => expect(screen.getByLabelText('Runtime')).not.toBeDisabled());
      expect(screen.getByLabelText('Runtime')).toHaveValue('chat');
      await act(async () => resolveOld({ runtimeMode: 'terminal' }));
      expect(screen.getByLabelText('Runtime')).toHaveValue('chat');
    });

    it('rolls back a failed runtime save, prevents overlap, and permits retry', async () => {
      window.clubhouse.agent.getDurableConfig = vi.fn().mockResolvedValue({ runtimeMode: 'terminal' } as never);
      let reject!: (error: Error) => void;
      const update = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
      window.clubhouse.agent.updateDurableConfig = update;
      renderSettings();
      const select = await screen.findByLabelText('Runtime');
      await waitFor(() => expect(select).toHaveValue('terminal'));
      fireEvent.change(select, { target: { value: 'chat' } });
      expect(select).toBeDisabled();
      fireEvent.change(select, { target: { value: '' } });
      expect(update).toHaveBeenCalledTimes(1);
      await act(async () => reject(new Error('synthetic failure')));
      expect(select).toHaveValue('terminal');
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save that setting");
      fireEvent.change(select, { target: { value: 'chat' } });
      await waitFor(() => expect(select).not.toBeDisabled());
      expect(select).toHaveValue('chat');
      expect(screen.queryByText(/Couldn't save that setting/)).not.toBeInTheDocument();
    });

    it('ignores a rejected save after switching to another target', async () => {
      window.clubhouse.agent.getDurableConfig = vi.fn().mockImplementation(async (_path, id) => ({ runtimeMode: id === 'agent-1' ? 'terminal' : 'chat' }));
      let reject!: (error: Error) => void;
      window.clubhouse.agent.updateDurableConfig = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
      const view = renderSettings();
      const select = await screen.findByLabelText('Runtime');
      await waitFor(() => expect(select).toHaveValue('terminal'));
      fireEvent.change(select, { target: { value: 'chat' } });
      const other = { ...defaultAgent, id: 'agent-2' };
      useAgentStore.setState({ agents: { [other.id]: other } });
      view.rerender(<AgentSettingsView agent={other} />);
      await waitFor(() => expect(screen.getByLabelText('Runtime')).not.toBeDisabled());
      expect(screen.getByLabelText('Runtime')).toHaveValue('chat');
      await act(async () => reject(new Error('old target failure')));
      expect(screen.getByLabelText('Runtime')).toHaveValue('chat');
      expect(screen.queryByText(/Couldn't save that setting/)).not.toBeInTheDocument();
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

  // The classic shell still edits a plain agent's files (D65), so the save bar,
  // the leave guard and the section reports are covered there.
  describe('classic shell editors', () => {
    beforeEach(() => {
      useChromeFlagStore.setState({ enabled: false });
      useToastStore.setState({ toasts: [] });
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
      await waitFor(() => expect(editor).toHaveValue('Agent instructions'));
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

    it('shows the launch wrapper states as plain words', async () => {
      (window.clubhouse.project as any).readMcpCatalog = vi.fn().mockResolvedValue([
        { id: 'fs', name: 'Filesystem', command: 'fs' },
      ]);
      renderSettings();
      const wrapper = await screen.findByTestId('agent-settings-launch-wrapper');
      expect(wrapper).toHaveTextContent('Launch wrapper');
      expect(wrapper).toHaveTextContent('Filesystem');
      expect(wrapper.querySelector('.uppercase')).toBeNull();
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

    it('takes sidebar counts from the sections for an agent on another machine, the one that has those pages', async () => {
      const remoteProject = 'remote||sat-1||proj-1';
      useProjectStore.setState({ projects: [{ id: remoteProject, name: 'far-app', path: '/remote/project' }], activeProjectId: remoteProject });
      renderSettings({ projectId: remoteProject });
      expect(screen.getByTestId('agent-settings-page-skills')).toContainElement(await screen.findByTestId('skills-section'));
      expect(screen.getByTestId('agent-settings-page-mcp')).toContainElement(screen.getByTestId('mcp-json-section'));
      act(() => {
        skillsProps.onCountChange(2);
        mcpProps.onCountChange(3);
      });
      expect(useAgentSettingsPages.getState().counts).toEqual({ skills: 2, mcp: 3 });
    });

    it('has no header and opens on General', () => {
      renderSettings();
      expect(screen.queryByTitle('Back')).not.toBeInTheDocument();
      expect(visiblePage().map((el) => el.dataset.testid)).toEqual(['agent-settings-page-general']);
      expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    });

    it('resets to General when another agent opens', () => {
      useAgentSettingsPages.getState().setPage('permissions');
      renderSettings();
      expect(useAgentSettingsPages.getState().page).toBe('general');
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

    it('closes at once when nothing is unsaved', () => {
      const closeAgentSettings = vi.fn();
      useAgentStore.setState({ closeAgentSettings });
      renderSettings();
      act(() => requestCloseAgentSettings());
      expect(closeAgentSettings).toHaveBeenCalled();
    });

    it('opens on a requested page once a managed agent\'s setup shows it (#2896)', async () => {
      (window.clubhouse.agent as any).getDurableConfig = vi.fn().mockResolvedValue({ managed: { version: 1, blocks: [], skills: [], mcps: [] } });
      useAgentSettingsPages.getState().setRequestedPage({ agentId: defaultAgent.id, page: 'preview' });
      try {
        renderSettings();
        await waitFor(() => expect(useAgentSettingsPages.getState().page).toBe('preview'));
        expect(useAgentSettingsPages.getState().requestedPage).toBeNull();
      } finally {
        useAgentSettingsPages.getState().setRequestedPage(null);
      }
    });

    it('ignores a page requested for another agent', async () => {
      useAgentSettingsPages.getState().setRequestedPage({ agentId: 'someone-else', page: 'mcp' });
      try {
        renderSettings();
        await act(async () => { await Promise.resolve(); });
        expect(useAgentSettingsPages.getState().page).toBe('general');
      } finally {
        useAgentSettingsPages.getState().setRequestedPage(null);
      }
    });

    it('opens the shell from the store and hides its row while closed', () => {
      renderSettings();
      expect(screen.getByTestId('agent-settings-shell')).toHaveClass('hidden');
      act(() => useAgentSettingsPages.getState().setShellOpen(true));
      expect(screen.getByTestId('agent-settings-shell')).not.toHaveClass('hidden');
      expect(screen.getByTestId('utility-terminal')).toBeInTheDocument();
    });
  });
});
