import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore } from '../../stores/headlessStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { OrchestratorSettingsView } from './OrchestratorSettingsView';
import { loadChatFlag, resetChatFlag } from '../agents/chat/chat-flag';
import { loadRichChatContentFlag, resetRichChatContentFlag } from '../agents/chat/rich/rich-flag';
import { useUIStore } from '../../stores/uiStore';

// Mock ProjectAgentDefaultsSection to avoid deep component tree
vi.mock('./ProjectAgentDefaultsSection', () => ({
  ProjectAgentDefaultsSection: ({ projectPath }: any) => (
    <div data-testid="project-agent-defaults" data-path={projectPath} />
  ),
}));

const originalMcpOffImpact = window.clubhouse.app.getMcpOffImpact;

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
  useSessionSettingsStore.setState({
    promptForName: false,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setPromptForName: vi.fn(),
    setProjectOverride: vi.fn(),
    clearProjectOverride: vi.fn(),
  });
  window.clubhouse.app.getMcpOffImpact = originalMcpOffImpact;
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
    it('renders the Agents & providers heading', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Agents & providers')).toBeInTheDocument();
      expect(screen.getByText('Configure agent providers and agent behavior.')).toBeInTheDocument();
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

    it('renders Agent providers section', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Agent providers')).toBeInTheDocument();
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
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
        expect(screen.getByText('No agent providers registered.')).toBeInTheDocument();
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
          expect(screen.getByTestId('orchestrator-toggle-claude-code')).toHaveAttribute('title', 'At least one agent provider must be enabled');
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
      window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue(on ? {} : { chat: false });
      window.clubhouse.app.saveExperimentalSettings = vi.fn().mockResolvedValue(undefined);
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
      await screen.findByRole('switch', { name: 'Chat view' });
      expect(screen.queryByTestId('chat-idle-timeout')).not.toBeInTheDocument();
    });

    it('is hidden when Chat is saved off, whatever is saved for the provider', async () => {
      setChatFlag(false);
      getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'chat' } });
      render(<OrchestratorSettingsView />);
      await screen.findByRole('switch', { name: 'Chat view' });
      expect(screen.getByText('Hook server')).toBeInTheDocument();
      expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
    });

    describe('the Chat section', () => {
      it('turns a saved-off Chat back on, keeping other flags and provider choices', async () => {
        setChatFlag(false);
        window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: false, goobers: true });
        getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'terminal' } });
        render(<OrchestratorSettingsView />);
        const toggle = await screen.findByRole('switch', { name: 'Chat view' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(toggle);
        await waitFor(() => expect(window.clubhouse.app.saveExperimentalSettings).toHaveBeenCalledWith({ chat: true, goobers: true }));
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        const row = await screen.findByTestId('runtime-mode-claude-code');
        expect(within(row).getByRole('radio', { name: 'CLI' })).toHaveAttribute('aria-checked', 'true');
        expect(saveRuntimeSettings).not.toHaveBeenCalled();
      });

      it('reads both flags as on when nothing is saved, and a change saves only that flag', async () => {
        setChatFlag(true);
        render(<OrchestratorSettingsView />);
        const rich = await screen.findByRole('switch', { name: 'Rich chat content' });
        expect(rich).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('switch', { name: 'Chat view' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(rich);
        await waitFor(() => expect(window.clubhouse.app.saveExperimentalSettings).toHaveBeenCalledWith({ richChatContent: false }));
      });

      it('shows a saved-off rich content setting, even with Chat off, so it can be changed', async () => {
        window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: false, richChatContent: false });
        window.clubhouse.app.saveExperimentalSettings = vi.fn().mockResolvedValue(undefined);
        render(<OrchestratorSettingsView />);
        const rich = await screen.findByRole('switch', { name: 'Rich chat content' });
        expect(rich).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(rich);
        await waitFor(() => expect(window.clubhouse.app.saveExperimentalSettings).toHaveBeenCalledWith({ chat: false, richChatContent: true }));
      });

      it.each([
        ['Chat view', 'chat', {}],
        ['Rich chat content', 'richChatContent', {}],
        ['Chat view', 'chat', { chat: false }],
        ['Rich chat content', 'richChatContent', { richChatContent: false }],
      ])('%s (saved %s, from %j): a refused save reverts the switch and says so, and a retry works', async (name, key, saved) => {
        const was = (saved as Record<string, boolean>)[key] !== false;
        const save = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined);
        window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue(saved);
        window.clubhouse.app.saveExperimentalSettings = save;
        render(<OrchestratorSettingsView />);
        const toggle = await screen.findByRole('switch', { name });
        expect(toggle).toHaveAttribute('aria-checked', String(was));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting, so it wasn't changed. Try again.");
        expect(toggle).toHaveAttribute('aria-checked', String(was));

        fireEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', String(!was)));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
        expect(save).toHaveBeenLastCalledWith({ ...saved, [key]: !was });
        expect(save).toHaveBeenCalledTimes(2);
      });

      it('treats a failed read before the save the same way', async () => {
        setChatFlag(true);
        window.clubhouse.app.getExperimentalSettings = vi.fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('unreadable'))
          .mockResolvedValue({});
        render(<OrchestratorSettingsView />);
        const toggle = await screen.findByRole('switch', { name: 'Chat view' });
        fireEvent.click(toggle);
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting");
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(window.clubhouse.app.saveExperimentalSettings).not.toHaveBeenCalled();
      });

      it('keeps the panes\' flags as they are when the save fails', async () => {
        window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ chat: false, richChatContent: false });
        window.clubhouse.app.saveExperimentalSettings = vi.fn().mockRejectedValue(new Error('refused'));
        resetChatFlag();
        resetRichChatContentFlag();
        expect(await loadChatFlag()).toBe(false);
        expect(await loadRichChatContentFlag()).toBe(false);
        render(<OrchestratorSettingsView />);
        fireEvent.click(await screen.findByRole('switch', { name: 'Chat view' }));
        fireEvent.click(screen.getByRole('switch', { name: 'Rich chat content' }));
        await screen.findByRole('alert');

        // Still the answers loaded above: nothing was forgotten, so main isn't asked again.
        const reads = vi.mocked(window.clubhouse.app.getExperimentalSettings).mock.calls.length;
        await loadChatFlag();
        await loadRichChatContentFlag();
        expect(vi.mocked(window.clubhouse.app.getExperimentalSettings).mock.calls.length).toBe(reads);
        resetChatFlag();
        resetRichChatContentFlag();
      });

      it('says what the rich content setting lets paired phones do', async () => {
        setChatFlag(true);
        render(<OrchestratorSettingsView />);
        expect(await screen.findByText(/paired phones \(Clubhouse Go\) can also read any file your user account can read on this computer, up to a size limit/)).toBeInTheDocument();
      });
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

      function setSdkFlag() {
        window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ copilotSdk: true });
      }

      it('is not offered with its flag off, even with the SDK saved, and the choice stays saved', async () => {
        setChatFlag(true);
        getRuntimeSettings.mockResolvedValue({ 'copilot-cli': { mode: 'chat', driver: 'copilot_sdk' } });
        render(<OrchestratorSettingsView />);
        const row = await screen.findByTestId('runtime-mode-copilot-cli');
        await waitFor(() => expect(within(row).getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true'));
        expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument();
        fireEvent.click(within(row).getByRole('radio', { name: 'CLI' }));
        await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledWith({ 'copilot-cli': { mode: 'terminal', driver: 'copilot_sdk' } }));
      });

      it('does not offer a second driver selector even when SDK is enabled', async () => {
        setSdkFlag();
        render(<OrchestratorSettingsView />);
        await screen.findByTestId('runtime-mode-copilot-cli');
        expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument();
      });

      it('rolls back a failed mode save and supports retry while preserving other providers', async () => {
        const saved = { 'claude-code': { mode: 'terminal' as const }, 'copilot-cli': { mode: 'chat' as const } };
        getRuntimeSettings.mockResolvedValue(saved);
        saveRuntimeSettings.mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined);
        render(<OrchestratorSettingsView />);
        const row = await screen.findByTestId('runtime-mode-copilot-cli');
        const cli = within(row).getByRole('radio', { name: 'CLI' });
        fireEvent.click(cli);
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting");
        expect(within(row).getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(cli);
        await waitFor(() => expect(cli).not.toBeDisabled());
        expect(saveRuntimeSettings).toHaveBeenLastCalledWith({ ...saved, 'copilot-cli': { mode: 'terminal' } });
      });

      it('does not write after a refresh read fails', async () => {
        getRuntimeSettings.mockResolvedValueOnce({ 'copilot-cli': { mode: 'chat' } }).mockRejectedValueOnce(new Error('refused'));
        render(<OrchestratorSettingsView />);
        const row = await screen.findByTestId('runtime-mode-copilot-cli');
        fireEvent.click(within(row).getByRole('radio', { name: 'CLI' }));
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting");
        expect(within(row).getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
        expect(saveRuntimeSettings).not.toHaveBeenCalled();
      });

      it('serializes mode saves and rolls back mode after a rejected write', async () => {
        setSdkFlag();
        getRuntimeSettings.mockResolvedValue({ 'copilot-cli': { mode: 'chat', driver: 'copilot_sdk' } });
        let reject!: (error: Error) => void;
        saveRuntimeSettings.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
        render(<OrchestratorSettingsView />);
        const row = await screen.findByTestId('runtime-mode-copilot-cli');
        fireEvent.click(within(row).getByRole('radio', { name: 'CLI' }));
        await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledTimes(1));
        expect(within(row).getByRole('radio', { name: 'Chat' })).toBeDisabled();
        fireEvent.click(within(row).getByRole('radio', { name: 'Chat' }));
        expect(saveRuntimeSettings).toHaveBeenCalledTimes(1);
        reject(new Error('synthetic failure'));
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting");
        expect(within(row).getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument();
      });

      it('is hidden when the agent opens in the CLI, and when chat is off', async () => {
        setSdkFlag();
        getRuntimeSettings.mockResolvedValue({ 'copilot-cli': { mode: 'terminal' } });
        const { unmount } = render(<OrchestratorSettingsView />);
        await screen.findByTestId('runtime-mode-copilot-cli');
        await waitFor(() => expect(screen.queryByTestId('chat-driver-copilot-cli')).not.toBeInTheDocument());
        unmount();
        setChatFlag(false);
        render(<OrchestratorSettingsView />);
        await screen.findByRole('switch', { name: 'Chat view' });
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
      expect(screen.getByText('Configure the agent provider and agent behavior for this project.')).toBeInTheDocument();
    });

    it('renders Quick Agent Mode dropdown', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Quick agent mode')).toBeInTheDocument();
    });

    it('renders ProjectAgentDefaultsSection', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByTestId('project-agent-defaults')).toBeInTheDocument();
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
      expect(screen.getByText('Agents & providers')).toBeInTheDocument();
      expect(screen.queryByText('Clubhouse Mode')).not.toBeInTheDocument();
    });

    describe('project override dropdowns clickability', () => {
      it('all override dropdowns are enabled', () => {
        render(<OrchestratorSettingsView projectId="proj-1" />);

        const selects = screen.getAllByRole('combobox');
        for (const select of selects) {
          expect(select).not.toBeDisabled();
        }
      });

      it('each project override select is labelled by its row', () => {
        useMcpSettingsStore.setState({ enabled: true });
        render(<OrchestratorSettingsView projectId="proj-1" />);
        for (const name of ['Quick agent mode', 'Free agent permission mode', 'Session name on quit', 'MCP override']) {
          expect(screen.getByLabelText(name).tagName).toBe('SELECT');
        }
      });

      describe('turning MCP off for the project', () => {
        const losing = {
          turnsOff: true, appLoses: false, projectsLosing: ['my-app'], agentsLosing: 2, quickAgentsLosing: 0, agentsKeeping: 1, helpersReportOnly: 1, orchestratorsLosing: 1, connectedLosing: 1,
          runningLosing: 1, runningOrchestratorsWithHelpers: 1, dispatcherGoesOff: false, dispatcherRunning: true, keeps: { projects: [], agents: [{ name: 'lead', project: 'my-app' }] }, unreadableProjects: [],
        };

        it('shows the MCP override with the app-wide bridge off: it still works then', () => {
          render(<OrchestratorSettingsView projectId="proj-1" />);
          expect(screen.getByLabelText('MCP override')).toBeInTheDocument();
        });

        it('asks before saving an override off, names what stays, and Cancel leaves it', async () => {
          const saveSettings = vi.fn().mockResolvedValue(undefined);
          useMcpSettingsStore.setState({ enabled: true, saveSettings } as never);
          window.clubhouse.app.getMcpOffImpact = vi.fn(async () => losing);
          render(<OrchestratorSettingsView projectId="proj-1" />);
          fireEvent.change(screen.getByLabelText('MCP override'), { target: { value: 'off' } });
          expect(await screen.findByTestId('mcp-off-dialog')).toBeInTheDocument();
          expect(window.clubhouse.app.getMcpOffImpact).toHaveBeenCalledWith({ mcp: { projectOverrides: { '/home/user/my-app': false } } });
          expect(screen.getByTestId('mcp-off-lead')).toHaveTextContent('In my-app, helpers, orchestration and connections to the Dispatcher stop working.');
          expect(screen.getByTestId('mcp-off-keeps')).toHaveTextContent('These keep Clubhouse MCP: lead in my-app (its own setting).');
          // App-level only: a project going off leaves the Dispatcher alone.
          expect(screen.queryByTestId('mcp-off-stop-dispatcher')).toBeNull();
          fireEvent.click(screen.getByTestId('mcp-off-cancel'));
          expect(saveSettings).not.toHaveBeenCalled();
        });

        it('saves once confirmed', async () => {
          const saveSettings = vi.fn(async (updates: object) => { useMcpSettingsStore.setState(updates as never); });
          useMcpSettingsStore.setState({ enabled: true, saveSettings } as never);
          window.clubhouse.app.getMcpOffImpact = vi.fn(async () => losing);
          render(<OrchestratorSettingsView projectId="proj-1" />);
          fireEvent.change(screen.getByLabelText('MCP override'), { target: { value: 'off' } });
          fireEvent.click(await screen.findByTestId('mcp-off-confirm'));
          await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ projectOverrides: { '/home/user/my-app': false } }));
          await waitFor(() => expect(screen.queryByTestId('mcp-off-dialog')).toBeNull());
        });

      });

    });
  });

  describe('without Clubhouse Mode settings (#2901)', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [{ id: 'proj-1', name: 'my-app', path: '/home/user/my-app' }],
        updateProject: vi.fn(),
      });
    });
    it('offers no Clubhouse Mode switch or wildcards app-wide', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Prompt for session name on quit')).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Clubhouse Mode' })).not.toBeInTheDocument();
      expect(screen.queryByText('.clubhouse/clubhouse-mode.md')).not.toBeInTheDocument();
    });

    it('sets the app-wide source control provider in its own store (D61)', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      window.clubhouse.settings.get = vi.fn().mockImplementation(async (key: string) => (key === 'source_control' ? { provider: 'azure-devops' } : null));
      window.clubhouse.settings.save = save;
      render(<OrchestratorSettingsView />);
      const select = screen.getByLabelText('Source control provider');
      await waitFor(() => expect(select).toHaveValue('azure-devops'));
      fireEvent.change(select, { target: { value: 'github' } });
      await waitFor(() => expect(save).toHaveBeenCalledWith('source_control', { provider: 'github' }));
    });

    it('offers no Clubhouse Mode choice for a project', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Quick agent mode')).toBeInTheDocument();
      expect(screen.queryByLabelText('Clubhouse Mode')).not.toBeInTheDocument();
    });
  });
});
