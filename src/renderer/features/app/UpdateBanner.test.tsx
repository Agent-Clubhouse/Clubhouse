import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';
import { UpdateBanner } from './UpdateBanner';

// Mock window.clubhouse to prevent errors from agentStore
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getUpdateSettings: vi.fn().mockResolvedValue({}),
        saveUpdateSettings: vi.fn().mockResolvedValue(undefined),
        checkForUpdates: vi.fn().mockResolvedValue({}),
        getUpdateStatus: vi.fn().mockResolvedValue({}),
        applyUpdate: vi.fn().mockResolvedValue(undefined),
        onUpdateStatusChanged: vi.fn().mockReturnValue(vi.fn()),
        getNotificationSettings: vi.fn().mockResolvedValue({}),
        saveNotificationSettings: vi.fn().mockResolvedValue(undefined),
        sendNotification: vi.fn().mockResolvedValue(undefined),
        onNotificationClicked: vi.fn().mockReturnValue(vi.fn()),
        onOpenSettings: vi.fn().mockReturnValue(vi.fn()),
        getTheme: vi.fn().mockResolvedValue({}),
        saveTheme: vi.fn().mockResolvedValue(undefined),
        getOrchestratorSettings: vi.fn().mockResolvedValue({}),
        saveOrchestratorSettings: vi.fn().mockResolvedValue(undefined),
        getVersion: vi.fn().mockResolvedValue('0.25.0'),
        getHeadlessSettings: vi.fn().mockResolvedValue({}),
        saveHeadlessSettings: vi.fn().mockResolvedValue(undefined),
        setDockBadge: vi.fn().mockResolvedValue(undefined),
        getBadgeSettings: vi.fn().mockResolvedValue({}),
        saveBadgeSettings: vi.fn().mockResolvedValue(undefined),
        openExternalUrl: vi.fn().mockResolvedValue(undefined),
        getPendingReleaseNotes: vi.fn().mockResolvedValue(null),
        clearPendingReleaseNotes: vi.fn().mockResolvedValue(undefined),
      },
      pty: {
        onData: vi.fn().mockReturnValue(vi.fn()),
        onExit: vi.fn().mockReturnValue(vi.fn()),
        spawnShell: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        onHookEvent: vi.fn().mockReturnValue(vi.fn()),
        killAgent: vi.fn().mockResolvedValue(undefined),
        getOrchestrators: vi.fn().mockResolvedValue([]),
        checkOrchestrator: vi.fn().mockResolvedValue({ available: true }),
      },
      project: {
        list: vi.fn().mockResolvedValue([]),
      },
    },
  },
  writable: true,
});

function resetStores() {
  useUpdateStore.setState({
    status: {
      state: 'idle',
      availableVersion: null,
      releaseNotes: null,
      releaseMessage: null,
      downloadProgress: 0,
      error: null,
      downloadPath: null,
    },
    settings: {
      autoUpdate: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    },
    dismissed: false,
  });
  useAgentStore.setState({
    agents: {},
    activeAgentId: null,
    agentSettingsOpenFor: null,
    agentDetailedStatus: {},
  });
}

describe('UpdateBanner', () => {
  beforeEach(resetStores);

  it('renders nothing when state is idle', () => {
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when state is checking', () => {
    useUpdateStore.setState({
      status: {
        state: 'checking',
        availableVersion: null,
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 0,
        error: null,
        downloadPath: null,
      },
    });
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when state is downloading', () => {
    useUpdateStore.setState({
      status: {
        state: 'downloading',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 50,
        error: null,
        downloadPath: null,
      },
    });
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders blue banner when update is ready', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });

    render(<UpdateBanner />);

    const banner = screen.getByTestId('update-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/v0\.26\.0/)).toBeInTheDocument();
    expect(screen.getByTestId('update-restart-btn')).toBeInTheDocument();
  });

  it('shows release message tagline when available', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: '## Full release notes markdown',
        releaseMessage: 'Plugin Improvements & More',
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-release-message')).toBeInTheDocument();
    expect(screen.getByText(/Plugin Improvements & More/)).toBeInTheDocument();
  });

  it('does not show tagline when releaseMessage is null', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: 'Some notes',
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });

    render(<UpdateBanner />);

    expect(screen.queryByTestId('update-release-message')).toBeNull();
  });

  it('renders nothing when dismissed', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
      dismissed: true,
    });

    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('dismiss button hides the banner', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('update-dismiss-btn'));

    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it('restart button calls applyUpdate when no agents running', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });

    render(<UpdateBanner />);

    fireEvent.click(screen.getByTestId('update-restart-btn'));

    // With no running agents, should call applyUpdate directly
    expect(vi.mocked(window.clubhouse.app.applyUpdate)).toHaveBeenCalled();
  });

  it('shows confirmation when agents are running', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });
    useAgentStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'test-agent',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });

    render(<UpdateBanner />);

    // First click should show confirmation
    fireEvent.click(screen.getByTestId('update-restart-btn'));

    expect(screen.getByTestId('update-confirm-message')).toBeInTheDocument();
    expect(screen.getByText(/1 running agent/)).toBeInTheDocument();
    expect(screen.getByTestId('update-confirm-restart')).toBeInTheDocument();
  });

  it('confirms and restarts on second click', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });
    useAgentStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'test-agent',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });

    render(<UpdateBanner />);

    // First click: show confirmation
    fireEvent.click(screen.getByTestId('update-restart-btn'));
    // Second click: confirm restart
    fireEvent.click(screen.getByTestId('update-confirm-restart'));

    expect(vi.mocked(window.clubhouse.app.applyUpdate)).toHaveBeenCalled();
  });

  it('cancel in confirmation returns to normal state', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });
    useAgentStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'test-agent',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });

    render(<UpdateBanner />);

    // Enter confirmation
    fireEvent.click(screen.getByTestId('update-restart-btn'));
    expect(screen.getByTestId('update-confirm-message')).toBeInTheDocument();

    // Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Back to normal state
    expect(screen.queryByTestId('update-confirm-message')).toBeNull();
    expect(screen.getByTestId('update-restart-btn')).toBeInTheDocument();
  });

  it('shows plural agent count', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
      },
    });
    useAgentStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1', projectId: 'proj-1', name: 'agent-1',
          kind: 'durable', status: 'running', color: 'indigo',
        },
        'agent-2': {
          id: 'agent-2', projectId: 'proj-1', name: 'agent-2',
          kind: 'quick', status: 'running', color: 'green',
        },
        'agent-3': {
          id: 'agent-3', projectId: 'proj-1', name: 'agent-3',
          kind: 'durable', status: 'sleeping', color: 'red',
        },
      },
    });

    render(<UpdateBanner />);

    fireEvent.click(screen.getByTestId('update-restart-btn'));

    // Should show 2 running agents (agent-3 is sleeping)
    expect(screen.getByText(/2 running agents/)).toBeInTheDocument();
  });
});
