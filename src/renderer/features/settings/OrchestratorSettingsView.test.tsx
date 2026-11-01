import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore } from '../../stores/headlessStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { OrchestratorSettingsView } from './OrchestratorSettingsView';
import { useUIStore } from '../../stores/uiStore';
import { CHAT_DEFAULT_TIP_KEY } from '../agents/chat/chat-default-tip';

// Mock ProjectAgentDefaultsSection to avoid deep component tree
vi.mock('./ProjectAgentDefaultsSection', () => ({
  ProjectAgentDefaultsSection: ({ projectPath, clubhouseMode }: any) => (
    <div data-testid="project-agent-defaults" data-path={projectPath} data-clubhouse-mode={String(clubhouseMode)} />
  ),
}));

function resetStores() {
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        shortName: 'CC',
        capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
      },
    ],
    availability: { 'claude-code': { available: true } },
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn(),
    checkAllAvailability: vi.fn().mockResolvedValue(undefined),
  });
  useHeadlessStore.setState({
    defaultMode: 'headless' as const,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setDefaultMode: vi.fn(),
    setProjectMode: vi.fn(),
    clearProjectMode: vi.fn(),
  });
  useClubhouseModeStore.setState({
    enabled: false,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn(),
    setProjectOverride: vi.fn(),
    clearProjectOverride: vi.fn(),
    isEnabledForProject: () => false,
  });
  useSessionSettingsStore.setState({
    promptForName: false,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setPromptForName: vi.fn(),
    setProjectOverride: vi.fn(),
    clearProjectOverride: vi.fn(),
  });
  useMcpSettingsStore.setState({
    enabled: false,
    projectDefault: true,
    projectOverrides: undefined,
    loaded: true,
    loadSettings: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  });
}

describe('OrchestratorSettingsView', () => {
  beforeEach(resetStores);

  describe('app-level settings (no projectId)', () => {
    it('renders the Orchestrators & agents heading', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Orchestrators & agents')).toBeInTheDocument();
      expect(screen.getByText('Configure orchestrator backends and agent behavior.')).toBeInTheDocument();
    });

    it('renders Clubhouse Mode toggle', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Clubhouse Mode')).toBeInTheDocument();
      expect(screen.getByText(/Manage agent instructions, permissions and MCP config/)).toBeInTheDocument();
    });

    it('renders Default quick agent mode dropdown', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Default quick agent mode')).toBeInTheDocument();
    });

    it('renders Quick Agent Mode dropdown with interactive and headless options', () => {
      render(<OrchestratorSettingsView />);
      const dropdown = screen.getByDisplayValue('Headless');
      expect(dropdown).toBeInTheDocument();
      const options = dropdown.querySelectorAll('option');
      const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
      expect(optionValues).toEqual(['interactive', 'headless']);
    });

    it('does not offer structured mode as a Quick Agent Mode option', () => {
      render(<OrchestratorSettingsView />);
      const dropdown = screen.getByDisplayValue('Headless');
      const options = Array.from(dropdown.querySelectorAll('option'));
      expect(options.every((o) => o.getAttribute('value') !== 'structured')).toBe(true);
    });

    it('renders Quick agents section before Durable agents', () => {
      render(<OrchestratorSettingsView />);
      const quickAgents = screen.getByText('Quick agents');
      const clubhouse = screen.getByText('Durable agents');
      expect(quickAgents.compareDocumentPosition(clubhouse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    });

    it('renders Orchestrators section', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Orchestrators')).toBeInTheDocument();
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    describe('clubhouse mode toggle', () => {
      it('shows confirmation dialog when enabling', () => {
        render(<OrchestratorSettingsView />);
        // Find the toggle button for Clubhouse Mode
        const clubhouseToggle = screen.getByRole('switch', { name: 'Clubhouse Mode' });
        expect(clubhouseToggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(clubhouseToggle);

        expect(screen.getByText('Enable Clubhouse Mode?')).toBeInTheDocument();
        expect(screen.getByText(/overwrite agent settings/)).toBeInTheDocument();
      });

      it('enables on confirmation', () => {
        const setEnabled = vi.fn();
        useClubhouseModeStore.setState({ setEnabled });

        render(<OrchestratorSettingsView />);
        const clubhouseToggle = screen.getByRole('switch', { name: 'Clubhouse Mode' });
        expect(clubhouseToggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(clubhouseToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

        expect(setEnabled).toHaveBeenCalledWith(true);
      });

      it('cancels confirmation dialog', () => {
        render(<OrchestratorSettingsView />);
        const clubhouseToggle = screen.getByRole('switch', { name: 'Clubhouse Mode' });
        expect(clubhouseToggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(clubhouseToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('Enable Clubhouse Mode?')).not.toBeInTheDocument();
      });

      it('disables without confirmation when already enabled', () => {
        const setEnabled = vi.fn();
        useClubhouseModeStore.setState({ enabled: true, setEnabled });

        render(<OrchestratorSettingsView />);
        fireEvent.click(screen.getByRole('switch', { name: 'Clubhouse Mode' }));

        expect(setEnabled).toHaveBeenCalledWith(false);
        expect(screen.queryByText('Enable Clubhouse Mode?')).not.toBeInTheDocument();
      });

      it('shows wildcard info banner when enabled', () => {
        useClubhouseModeStore.setState({ enabled: true });
        render(<OrchestratorSettingsView />);

        expect(screen.getByText('@@AgentName')).toBeInTheDocument();
        expect(screen.getByText('@@StandbyBranch')).toBeInTheDocument();
        expect(screen.getByText('@@Path')).toBeInTheDocument();
        // Newly surfaced wildcards
        expect(screen.getByText('@@SourceControlProvider')).toBeInTheDocument();
        expect(screen.getByText('@@BuildCommand')).toBeInTheDocument();
        expect(screen.getByText('@@TestCommand')).toBeInTheDocument();
        expect(screen.getByText('@@LintCommand')).toBeInTheDocument();
        expect(screen.getByText('@@Mission')).toBeInTheDocument();
        expect(screen.getByText('@@Persona')).toBeInTheDocument();
      });

      it('references the self-edit guide path when enabled', () => {
        useClubhouseModeStore.setState({ enabled: true });
        render(<OrchestratorSettingsView />);

        expect(screen.getByText('.clubhouse/clubhouse-mode.md')).toBeInTheDocument();
      });

      it('hides wildcard banner when disabled', () => {
        useClubhouseModeStore.setState({ enabled: false });
        render(<OrchestratorSettingsView />);

        expect(screen.queryByText('@@AgentName')).not.toBeInTheDocument();
      });
    });

    describe('orchestrator list', () => {
      it('shows availability indicator', () => {
        useOrchestratorStore.setState({
          availability: { 'claude-code': { available: true } },
        });
        render(<OrchestratorSettingsView />);
        // Green dot has bg-green-500
        const dot = screen.getByTitle('CLI found');
        expect(dot).toBeInTheDocument();
      });

      it('shows error for unavailable orchestrator', () => {
        useOrchestratorStore.setState({
          availability: { 'claude-code': { available: false, error: 'CLI not found at /usr/bin/claude' } },
        });
        render(<OrchestratorSettingsView />);
        expect(screen.getByText('CLI not found at /usr/bin/claude')).toBeInTheDocument();
      });

      it('shows the status word and badge as plain meta text', () => {
        useOrchestratorStore.setState({
          allOrchestrators: [{
            id: 'claude-code',
            displayName: 'Claude Code',
            shortName: 'CC',
            badge: 'default',
            capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
          }],
        });
        render(<OrchestratorSettingsView />);
        expect(screen.getByText('· default')).toBeInTheDocument();
        expect(screen.getByText('Installed')).toBeInTheDocument();
      });

      it('shows empty state when no orchestrators', () => {
        useOrchestratorStore.setState({
          allOrchestrators: [],
          enabled: [],
        });
        render(<OrchestratorSettingsView />);
        expect(screen.getByText('No orchestrators registered.')).toBeInTheDocument();
      });

      describe('toggle disabled state when not installed', () => {
        it('toggle is NOT disabled when orchestrator is enabled but not installed (can turn it off)', () => {
          useOrchestratorStore.setState({
            enabled: ['claude-code'],
            availability: { 'claude-code': { available: false, error: 'CLI not found' } },
          });
          render(<OrchestratorSettingsView />);
          const orchToggle = screen.getByRole('switch', { name: 'Claude Code' });
          expect(orchToggle).toHaveAttribute('aria-checked', 'true');
          expect(orchToggle).toBeTruthy();
          expect(orchToggle).not.toBeDisabled();
        });

        it('toggle IS disabled when orchestrator is disabled and not installed (cannot turn it on)', () => {
          useOrchestratorStore.setState({
            enabled: ['other-cli'],
            allOrchestrators: [
              {
                id: 'claude-code',
                displayName: 'Claude Code',
                shortName: 'CC',
                capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
              },
              {
                id: 'other-cli',
                displayName: 'Other CLI',
                shortName: 'OC',
                capabilities: { headless: true, structuredOutput: false, hooks: false, sessionResume: false, permissions: false },
              },
            ],
            availability: {
              'claude-code': { available: false, error: 'CLI not found' },
              'other-cli': { available: true },
            },
          });
          render(<OrchestratorSettingsView />);
          // Not-installed orchestrators show the error under their name.
          expect(screen.getByText('CLI not found')).toBeInTheDocument();
          const claudeToggle = screen.getByRole('switch', { name: 'Claude Code' });
          expect(claudeToggle).toBeDisabled();
          // The reason is on the toggle's wrapper (a disabled button gets no hover).
          expect(screen.getByTestId('orchestrator-toggle-claude-code')).toHaveAttribute('title', 'CLI not found. Install it to enable.');
        });

        it('toggle is NOT disabled for last enabled orchestrator when it is not installed', () => {
          // The "only enabled + not installed" case: isOnlyEnabled && notInstalled → should allow turning off
          useOrchestratorStore.setState({
            enabled: ['claude-code'],
            availability: { 'claude-code': { available: false, error: 'CLI not found' } },
          });
          render(<OrchestratorSettingsView />);
          const orchToggle = screen.getByRole('switch', { name: 'Claude Code' });
          expect(orchToggle).toHaveAttribute('aria-checked', 'true');
          expect(orchToggle).not.toBeDisabled();
        });

        it('toggle IS disabled for last enabled orchestrator when it IS installed', () => {
          useOrchestratorStore.setState({
            enabled: ['claude-code'],
            availability: { 'claude-code': { available: true } },
          });
          render(<OrchestratorSettingsView />);
          const orchToggle = screen.getByRole('switch', { name: 'Claude Code' });
          expect(orchToggle).toHaveAttribute('aria-checked', 'true');
          expect(orchToggle).toBeDisabled();
          expect(screen.getByTestId('orchestrator-toggle-claude-code')).toHaveAttribute('title', 'At least one orchestrator must be enabled');
        });
      });
    });
  });

  describe('runtime (Chat / CLI) control', () => {
    const getRuntimeSettings = vi.fn();
    const saveRuntimeSettings = vi.fn();

    beforeEach(() => {
      getRuntimeSettings.mockReset().mockResolvedValue({});
      saveRuntimeSettings.mockReset().mockResolvedValue(undefined);
      window.clubhouse.chat.getRuntimeSettings = getRuntimeSettings;
      window.clubhouse.chat.saveRuntimeSettings = saveRuntimeSettings;
    });

    function setChatFlag(on: boolean) {
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue(on ? { chat: true } : {});
      window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
    }

    it('offers the chat idle timeout when chat is on, and saves Never as 0 (#2104)', async () => {
      setChatFlag(true);
      const save = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.settings.get = vi.fn().mockImplementation(async (key: string) => (key === 'chat_idle' ? { idleTimeoutMinutes: 30 } : null));
      window.clubhouse.settings.save = save;
      render(<OrchestratorSettingsView />);
      const select = await screen.findByTestId('chat-idle-timeout');
      await waitFor(() => expect(select).toHaveValue('30'));
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['15 minutes', '30 minutes', '1 hour', '4 hours', 'Never']);
      fireEvent.change(select, { target: { value: '0' } });
      await waitFor(() => expect(save).toHaveBeenCalledWith('chat_idle', { idleTimeoutMinutes: 0 }));
    });

    it('shows a hand-edited idle timeout that is not one of the choices (#2104)', async () => {
      setChatFlag(true);
      window.clubhouse.settings.get = vi.fn().mockImplementation(async (key: string) => (key === 'chat_idle' ? { idleTimeoutMinutes: 45 } : null));
      window.clubhouse.settings.save = vi.fn().mockResolvedValue(undefined);
      render(<OrchestratorSettingsView />);
      const select = await screen.findByTestId('chat-idle-timeout');
      await waitFor(() => expect(select).toHaveValue('45'));
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['15 minutes', '30 minutes', '45 minutes', '1 hour', '4 hours', 'Never']);
    });

    it('hides the chat idle timeout when chat is off (#2104)', async () => {
      setChatFlag(false);
      render(<OrchestratorSettingsView />);
      await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
      expect(screen.queryByTestId('chat-idle-timeout')).not.toBeInTheDocument();
    });

    it('is hidden on stable builds even when a Chat flag is saved', async () => {
      setChatFlag(true);
      window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(false);
      render(<OrchestratorSettingsView />);
      await waitFor(() => expect(window.clubhouse.app.isPreviewEligible).toHaveBeenCalled());
      expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
      expect(getRuntimeSettings).not.toHaveBeenCalled();
    });

    it('is hidden when the experimental Chat flag is off', async () => {
      setChatFlag(false);
      render(<OrchestratorSettingsView />);
      await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
      expect(screen.getByText('Hook server')).toBeInTheDocument();
      expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
      expect(getRuntimeSettings).not.toHaveBeenCalled();
    });

    describe('the Copilot chat driver choice', () => {
      beforeEach(() => {
        useOrchestratorStore.setState({
          enabled: ['claude-code', 'copilot-cli'],
          allOrchestrators: [
            { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true } },
            { id: 'copilot-cli', displayName: 'Copilot CLI', shortName: 'CP', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true } },
          ],
          availability: { 'claude-code': { available: true }, 'copilot-cli': { available: true } },
        });
      });

      it('defaults to ACP, and only Copilot offers it', async () => {
        setChatFlag(true);
        render(<OrchestratorSettingsView />);
        const select = await screen.findByTestId('chat-driver-copilot-cli');
        expect(select).toHaveValue('copilot_acp');
        expect(screen.queryByTestId('chat-driver-claude-code')).not.toBeInTheDocument();
      });

      it('saves the SDK when chosen, and clears the choice on going back', async () => {
        setChatFlag(true);
        getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'terminal' } });
        render(<OrchestratorSettingsView />);
        const select = await screen.findByTestId('chat-driver-copilot-cli');
        fireEvent.change(select, { target: { value: 'copilot_sdk' } });
        await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledWith({ 'claude-code': { mode: 'terminal' }, 'copilot-cli': { mode: 'chat', driver: 'copilot_sdk' } }));
        expect(select).toHaveValue('copilot_sdk');

        getRuntimeSettings.mockResolvedValue({ 'copilot-cli': { mode: 'chat', driver: 'copilot_sdk' } });
        fireEvent.change(select, { target: { value: 'copilot_acp' } });
        await waitFor(() => expect(saveRuntimeSettings).toHaveBeenLastCalledWith({ 'copilot-cli': { mode: 'chat' } }));
      });

      it('is hidden when the agent opens in the CLI, and when chat is off', async () => {
        setChatFlag(true);
        getRuntimeSettings.mockResolvedValue({ 'copilot-cli': { mode: 'terminal' } });
        const { unmount } = render(<OrchestratorSettingsView />);
        await screen.findByTestId('runtime-mode-copilot-cli');
        await waitFor(() => expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument());
        unmount();
        setChatFlag(false);
        render(<OrchestratorSettingsView />);
        await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
        expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument();
      });
    });

    it('shows Chat selected by default when the flag is on and nothing is saved', async () => {
      setChatFlag(true);
      render(<OrchestratorSettingsView />);
      const row = await screen.findByTestId('runtime-mode-claude-code');
      expect(within(row).getByText('Runtime')).toBeInTheDocument();
      expect(within(row).getByText(/Agents for this provider open in chat/)).toBeInTheDocument();
      expect(within(row).getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
      expect(within(row).getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'false');
      // The hook server toggle is still there alongside it.
      expect(screen.getByText('Hook server')).toBeInTheDocument();
    });

    it('reflects a saved Terminal setting', async () => {
      setChatFlag(true);
      getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'terminal' } });
      render(<OrchestratorSettingsView />);
      const row = await screen.findByTestId('runtime-mode-claude-code');
      await waitFor(() => {
        expect(within(row).getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'true');
      });
    });

    it('saves by merging into the stored settings without clobbering other providers', async () => {
      setChatFlag(true);
      getRuntimeSettings.mockResolvedValue({
        'codex-cli': { mode: 'terminal' },
        'claude-code': { mode: 'chat', driver: 'claude_agent_sdk' },
      });
      render(<OrchestratorSettingsView />);
      const row = await screen.findByTestId('runtime-mode-claude-code');
      fireEvent.click(within(row).getByRole('radio', { name: 'CLI' }));

      await waitFor(() => {
        expect(saveRuntimeSettings).toHaveBeenCalledWith({
          'codex-cli': { mode: 'terminal' },
          'claude-code': { mode: 'terminal', driver: 'claude_agent_sdk' },
        });
      });
      expect(within(row).getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'true');
    });

    it('shows for enabled orchestrators without hook support, without a hook server toggle', async () => {
      setChatFlag(true);
      useOrchestratorStore.setState({
        enabled: ['github-copilot'],
        allOrchestrators: [{
          id: 'github-copilot',
          displayName: 'GitHub Copilot',
          shortName: 'GHCP',
          capabilities: { headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: false },
        }],
        availability: { 'github-copilot': { available: true } },
      } as any);
      render(<OrchestratorSettingsView />);
      expect(await screen.findByTestId('runtime-mode-github-copilot')).toBeInTheDocument();
      expect(screen.queryByText('Hook server')).not.toBeInTheDocument();
    });

    it('records an explicit Terminal choice so the Chat default tip never shows', async () => {
      setChatFlag(true);
      localStorage.removeItem(CHAT_DEFAULT_TIP_KEY);
      render(<OrchestratorSettingsView />);
      const row = await screen.findByTestId('runtime-mode-claude-code');
      fireEvent.click(within(row).getByRole('radio', { name: 'CLI' }));
      expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('chose_terminal');
      localStorage.removeItem(CHAT_DEFAULT_TIP_KEY);
    });

    it('scrolls to and outlines the provider runtime row for the deep link, then clears the focus', async () => {
      setChatFlag(true);
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      useUIStore.getState().openRuntimeSettings('claude-code');
      render(<OrchestratorSettingsView />);
      const row = await screen.findByTestId('runtime-mode-claude-code');
      await waitFor(() => expect(row).toHaveAttribute('data-highlighted', 'true'));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
      expect(useUIStore.getState().settingsFocus).toBeNull();
    });

    it('drops the deep-link focus when chat is off, so it cannot fire later', async () => {
      setChatFlag(false);
      useUIStore.getState().openRuntimeSettings('claude-code');
      render(<OrchestratorSettingsView />);
      await waitFor(() => expect(useUIStore.getState().settingsFocus).toBeNull());
    });

    it('drops the deep-link focus for an unknown provider', async () => {
      setChatFlag(true);
      useUIStore.getState().openRuntimeSettings('no-such-cli');
      render(<OrchestratorSettingsView />);
      await screen.findByTestId('runtime-mode-claude-code');
      await waitFor(() => expect(useUIStore.getState().settingsFocus).toBeNull());
    });

    it('drops the deep-link focus when the page unmounts first', async () => {
      setChatFlag(true);
      window.clubhouse.app.getExperimentalSettings = vi.fn(() => new Promise(() => {})) as never;
      useUIStore.getState().openRuntimeSettings('claude-code');
      const { unmount } = render(<OrchestratorSettingsView />);
      expect(useUIStore.getState().settingsFocus).toBe('runtime:claude-code');
      unmount();
      expect(useUIStore.getState().settingsFocus).toBeNull();
    });

    it('is not shown for disabled orchestrators', async () => {
      setChatFlag(true);
      useOrchestratorStore.setState({
        enabled: ['claude-code'],
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true } },
          { id: 'codex-cli', displayName: 'Codex CLI', shortName: 'CX', capabilities: { headless: true, structuredOutput: false, hooks: true, sessionResume: false, permissions: false } },
        ],
      } as any);
      render(<OrchestratorSettingsView />);
      expect(await screen.findByTestId('runtime-mode-claude-code')).toBeInTheDocument();
      expect(screen.queryByTestId('runtime-mode-codex-cli')).not.toBeInTheDocument();
    });
  });

  describe('project-level settings (with projectId)', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [{ id: 'proj-1', name: 'my-app', path: '/home/user/my-app' }],
        updateProject: vi.fn(),
      });
    });

    it('renders project-level description', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Configure orchestrator and agent behavior for this project.')).toBeInTheDocument();
    });

    it('renders Clubhouse Mode dropdown', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Clubhouse Mode')).toBeInTheDocument();
    });

    it('renders Quick Agent Mode dropdown', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Quick agent mode')).toBeInTheDocument();
    });

    it('renders ProjectAgentDefaultsSection', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByTestId('project-agent-defaults')).toBeInTheDocument();
    });

    it('passes clubhouseMode to ProjectAgentDefaultsSection', () => {
      useClubhouseModeStore.setState({ enabled: true });
      render(<OrchestratorSettingsView projectId="proj-1" />);
      const defaults = screen.getByTestId('project-agent-defaults');
      expect(defaults.getAttribute('data-clubhouse-mode')).toBe('true');
    });

    it('does not show orchestrator picker with single orchestrator', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.queryByText('Agents run on')).not.toBeInTheDocument();
    });

    it('shows orchestrator picker with multiple orchestrators', () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code', 'codex-cli'],
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true } },
          { id: 'codex-cli', displayName: 'Codex CLI', shortName: 'CX', capabilities: { headless: true, structuredOutput: false, hooks: true, sessionResume: false, permissions: false } },
        ],
      });
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Agents run on')).toBeInTheDocument();
      expect(screen.queryByText('Default orchestrator')).not.toBeInTheDocument();
    });

    it('returns null for invalid project', () => {
      const { container: _container } = render(<OrchestratorSettingsView projectId="nonexistent" />);
      // Should still render the outer wrapper but ProjectAgentSettings returns null
      expect(screen.getByText('Orchestrators & agents')).toBeInTheDocument();
      expect(screen.queryByText('Clubhouse Mode')).not.toBeInTheDocument();
    });

    describe('project override dropdowns clickability', () => {
      it('all override dropdowns are enabled when clubhouse mode is on', () => {
        useClubhouseModeStore.setState({ enabled: true });
        render(<OrchestratorSettingsView projectId="proj-1" />);

        const selects = screen.getAllByRole('combobox');
        for (const select of selects) {
          expect(select).not.toBeDisabled();
        }
      });

      it('each project override select is labelled by its row', () => {
        useMcpSettingsStore.setState({ enabled: true });
        render(<OrchestratorSettingsView projectId="proj-1" />);
        for (const name of ['Quick agent mode', 'Free agent permission mode', 'Session name on quit', 'Clubhouse Mode', 'MCP override']) {
          expect(screen.getByLabelText(name).tagName).toBe('SELECT');
        }
      });

      it('Clubhouse Mode dropdown responds to change events when clubhouse is on', () => {
        const setProjectOverride = vi.fn();
        useClubhouseModeStore.setState({ enabled: true, setProjectOverride });

        render(<OrchestratorSettingsView projectId="proj-1" />);
        const select = screen.getByLabelText('Clubhouse Mode');
        fireEvent.change(select, { target: { value: 'on' } });
        expect(setProjectOverride).toHaveBeenCalledWith('/home/user/my-app', true);
      });
    });
  });
});
