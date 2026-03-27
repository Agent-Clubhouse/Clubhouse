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
        getLiveAgentsForUpdate: vi.fn().mockResolvedValue([]),
        confirmUpdateRestart: vi.fn().mockResolvedValue(undefined),
        resolveWorkingAgent: vi.fn().mockResolvedValue(undefined),
        onUpdateStatusChanged: vi.fn().mockReturnValue(vi.fn()),
        getNotificationSettings: vi.fn().mockResolvedValue({}),
        saveNotificationSettings: vi.fn().mockResolvedValue(undefined),
        sendNotification: vi.fn().mockResolvedValue(undefined),
        closeNotification: vi.fn().mockResolvedValue(undefined),
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
      artifactUrl: null,
      applyAttempted: false,
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
        artifactUrl: null,
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
        artifactUrl: null,
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
        artifactUrl: null,
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
        artifactUrl: null,
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
        artifactUrl: null,
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
        artifactUrl: null,
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
        artifactUrl: null,
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('update-dismiss-btn'));

    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it('restart button calls confirmUpdateRestart when no agents running', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: null,
      },
    });

    render(<UpdateBanner />);

    fireEvent.click(screen.getByTestId('update-restart-btn'));

    // With no running agents, should call confirmUpdateRestart directly
    expect(vi.mocked(window.clubhouse.app.confirmUpdateRestart)).toHaveBeenCalledWith({ agentNames: {} });
  });

  // --- Manual download fallback tests ---

  it('shows "Download manually" button when update is ready and artifactUrl is available', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: false,
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-manual-download-btn')).toBeInTheDocument();
    expect(screen.getByTestId('update-restart-btn')).toBeInTheDocument();
  });

  it('does not show "Download manually" when artifactUrl is null', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: null,
      },
    });

    render(<UpdateBanner />);

    expect(screen.queryByTestId('update-manual-download-btn')).toBeNull();
    expect(screen.getByTestId('update-restart-btn')).toBeInTheDocument();
  });

  it('shows error banner with manual download when apply fails', () => {
    useUpdateStore.setState({
      status: {
        state: 'error',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 0,
        error: 'Update failed: No .app found in update archive',
        downloadPath: null,
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: false,
      },
    });

    render(<UpdateBanner />);

    const banner = screen.getByTestId('update-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByTestId('update-error-message')).toBeInTheDocument();
    expect(screen.getByText(/failed to install/)).toBeInTheDocument();
    expect(screen.getByTestId('update-manual-download-btn')).toBeInTheDocument();
    // Should NOT show restart button in error state
    expect(screen.queryByTestId('update-restart-btn')).toBeNull();
  });

  it('does not show banner for error state without artifactUrl', () => {
    useUpdateStore.setState({
      status: {
        state: 'error',
        availableVersion: null,
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 0,
        error: 'Download failed: HTTP 404',
        downloadPath: null,
        artifactUrl: null,
      },
    });

    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('manual download button calls openExternalUrl with artifact URL', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: false,
      },
    });

    render(<UpdateBanner />);

    fireEvent.click(screen.getByTestId('update-manual-download-btn'));

    expect(vi.mocked(window.clubhouse.app.openExternalUrl)).toHaveBeenCalledWith(
      'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
    );
  });

  it('error banner can be dismissed', () => {
    useUpdateStore.setState({
      status: {
        state: 'error',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 0,
        error: 'Update failed',
        downloadPath: null,
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: false,
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('update-dismiss-btn'));

    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  // --- Apply attempt detection tests ---

  it('shows warning banner with "Download manually" primary when applyAttempted is true', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: true,
      },
    });

    render(<UpdateBanner />);

    expect(screen.getByTestId('update-retry-message')).toBeInTheDocument();
    expect(screen.getByText(/did not apply successfully/)).toBeInTheDocument();
    // Manual download should be the primary button
    expect(screen.getByTestId('update-manual-download-btn')).toBeInTheDocument();
    // "Try again" should be the secondary action
    expect(screen.getByTestId('update-restart-btn')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('does not show retry message when applyAttempted is false', () => {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        availableVersion: '0.26.0',
        releaseNotes: null,
        releaseMessage: null,
        downloadProgress: 100,
        error: null,
        downloadPath: '/tmp/update.zip',
        artifactUrl: 'https://cdn.example.com/Clubhouse-0.26.0-Setup.exe',
        applyAttempted: false,
      },
    });

    render(<UpdateBanner />);

    expect(screen.queryByTestId('update-retry-message')).toBeNull();
    expect(screen.getByText('Restart to update')).toBeInTheDocument();
  });
});
