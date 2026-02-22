import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore } from '../../stores/headlessStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { OrchestratorSettingsView } from './OrchestratorSettingsView';

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
    enabled: true,
    projectOverrides: {},
    loadSettings: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn(),
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
}

describe('OrchestratorSettingsView', () => {
  beforeEach(resetStores);

  describe('app-level settings (no projectId)', () => {
    it('renders the Agents heading', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Configure agent backends and behavior.')).toBeInTheDocument();
    });

    it('renders Clubhouse Mode toggle', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Clubhouse Mode')).toBeInTheDocument();
      expect(screen.getByText(/Centrally manage agent/)).toBeInTheDocument();
    });

    it('renders Headless Mode toggle', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Headless Mode')).toBeInTheDocument();
    });

    it('renders Headless Mode before Clubhouse Mode', () => {
      render(<OrchestratorSettingsView />);
      const headless = screen.getByText('Headless Mode');
      const clubhouse = screen.getByText('Clubhouse Mode');
      // Headless should appear before Clubhouse in the DOM
      expect(headless.compareDocumentPosition(clubhouse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders Orchestrators section', () => {
      render(<OrchestratorSettingsView />);
      expect(screen.getByText('Orchestrators')).toBeInTheDocument();
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
    });

    describe('clubhouse mode toggle', () => {
      it('shows confirmation dialog when enabling', () => {
        render(<OrchestratorSettingsView />);
        // Find the toggle button for Clubhouse Mode (first toggle-track)
        const toggleButtons = screen.getAllByRole('button');
        const clubhouseToggle = toggleButtons.find((btn) =>
          btn.className.includes('toggle-track') && btn.getAttribute('data-on') === 'false'
        );
        if (clubhouseToggle) fireEvent.click(clubhouseToggle);

        expect(screen.getByText('Enable Clubhouse Mode?')).toBeInTheDocument();
        expect(screen.getByText(/overwrite agent settings/)).toBeInTheDocument();
      });

      it('enables on confirmation', () => {
        const setEnabled = vi.fn();
        useClubhouseModeStore.setState({ setEnabled });

        render(<OrchestratorSettingsView />);
        const toggleButtons = screen.getAllByRole('button');
        const clubhouseToggle = toggleButtons.find((btn) =>
          btn.className.includes('toggle-track') && btn.getAttribute('data-on') === 'false'
        );
        if (clubhouseToggle) fireEvent.click(clubhouseToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

        expect(setEnabled).toHaveBeenCalledWith(true);
      });

      it('cancels confirmation dialog', () => {
        render(<OrchestratorSettingsView />);
        const toggleButtons = screen.getAllByRole('button');
        const clubhouseToggle = toggleButtons.find((btn) =>
          btn.className.includes('toggle-track') && btn.getAttribute('data-on') === 'false'
        );
        if (clubhouseToggle) fireEvent.click(clubhouseToggle);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('Enable Clubhouse Mode?')).not.toBeInTheDocument();
      });

      it('disables without confirmation when already enabled', () => {
        const setEnabled = vi.fn();
        useClubhouseModeStore.setState({ enabled: true, setEnabled });

        render(<OrchestratorSettingsView />);
        // Find the Clubhouse Mode toggle by traversing from the "Clubhouse Mode" text
        const clubhouseLabel = screen.getByText('Clubhouse Mode');
        const clubhouseSection = clubhouseLabel.closest('.flex.items-center.justify-between');
        const clubhouseToggle = clubhouseSection?.querySelector('.toggle-track');
        if (clubhouseToggle) fireEvent.click(clubhouseToggle);

        expect(setEnabled).toHaveBeenCalledWith(false);
        expect(screen.queryByText('Enable Clubhouse Mode?')).not.toBeInTheDocument();
      });

      it('shows wildcard info banner when enabled', () => {
        useClubhouseModeStore.setState({ enabled: true });
        render(<OrchestratorSettingsView />);

        expect(screen.getByText('@@AgentName')).toBeInTheDocument();
        expect(screen.getByText('@@StandbyBranch')).toBeInTheDocument();
        expect(screen.getByText('@@Path')).toBeInTheDocument();
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

      it('shows badge when present', () => {
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
        expect(screen.getByText('default')).toBeInTheDocument();
      });

      it('shows empty state when no orchestrators', () => {
        useOrchestratorStore.setState({
          allOrchestrators: [],
          enabled: [],
        });
        render(<OrchestratorSettingsView />);
        expect(screen.getByText('No orchestrators registered.')).toBeInTheDocument();
      });
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
      expect(screen.getByText('Configure agent behavior for this project.')).toBeInTheDocument();
    });

    it('renders Clubhouse Mode dropdown', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Clubhouse Mode')).toBeInTheDocument();
    });

    it('renders Quick Agent Mode dropdown', () => {
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Quick Agent Mode')).toBeInTheDocument();
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
      expect(screen.queryByText('Orchestrator')).not.toBeInTheDocument();
    });

    it('shows orchestrator picker with multiple orchestrators', () => {
      useOrchestratorStore.setState({
        enabled: ['claude-code', 'codex-cli'],
        allOrchestrators: [
          { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true } },
          { id: 'codex-cli', displayName: 'Codex CLI', shortName: 'CX', capabilities: { headless: true, structuredOutput: false, hooks: false, sessionResume: false, permissions: false } },
        ],
      });
      render(<OrchestratorSettingsView projectId="proj-1" />);
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    });

    it('returns null for invalid project', () => {
      const { container } = render(<OrchestratorSettingsView projectId="nonexistent" />);
      // Should still render the outer wrapper but ProjectAgentSettings returns null
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.queryByText('Clubhouse Mode')).not.toBeInTheDocument();
    });
  });
});
