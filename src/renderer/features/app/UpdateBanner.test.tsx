import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';
import { UpdateBanner } from './UpdateBanner';
import { UPDATE_AGENT_ACTION_TIMEOUT_MS, type LiveAgentInfo, type UpdateAgentActionResult } from '../../../shared/types';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { DISPATCHER_OFF } from '../../../shared/dispatcher-types';

// Mock window.clubhouse to prevent errors from agentStore
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getUpdateSettings: vi.fn().mockResolvedValue({}),
        saveUpdateSettings: vi.fn().mockResolvedValue(undefined),
        checkForUpdates: vi.fn().mockResolvedValue({}),
        getUpdateStatus: vi.fn().mockResolvedValue({}),
        getAppUpdateRequest: vi.fn().mockResolvedValue(null),
        cancelAppUpdateRequest: vi.fn(),
        onAppUpdateRequestChanged: vi.fn().mockReturnValue(vi.fn()),
        applyUpdate: vi.fn().mockResolvedValue(undefined),
        getLiveAgentsForUpdate: vi.fn().mockResolvedValue([]),
        confirmUpdateRestart: vi.fn().mockResolvedValue(undefined),
        resolveWorkingAgent: vi.fn().mockResolvedValue({ status: 'resolved', isWorking: false }),
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
  useDispatcherStore.setState({ state: null });
  vi.mocked(window.clubhouse.app.getAppUpdateRequest).mockResolvedValue(null);
  vi.mocked(window.clubhouse.app.onAppUpdateRequestChanged).mockReturnValue(vi.fn());
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

  it('shows an approved idle wait and lets the person cancel it without restarting', async () => {
    const pending = { requestId: 'update-1', state: 'waiting_for_idle' as const, version: '1.1.0', expiresAt: '2026-11-11T12:30:00Z', error: null };
    vi.mocked(window.clubhouse.app.getAppUpdateRequest).mockResolvedValueOnce(pending);
    vi.mocked(window.clubhouse.app.cancelAppUpdateRequest).mockResolvedValueOnce({ ...pending, state: 'cancelled' });
    render(<UpdateBanner />);
    const cancel = await screen.findByRole('button', { name: 'Cancel update' });
    expect(screen.getByRole('status')).toHaveTextContent('up to 30 minutes');
    await act(async () => { fireEvent.click(cancel); });
    expect(window.clubhouse.app.cancelAppUpdateRequest).toHaveBeenCalledWith('update-1');
    expect(screen.queryByRole('button', { name: 'Cancel update' })).not.toBeInTheDocument();
    expect(window.clubhouse.app.confirmUpdateRestart).not.toHaveBeenCalled();
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

describe('UpdateBanner card variant (new chrome)', () => {
  beforeEach(resetStores);

  const ready = (extra: Partial<ReturnType<typeof useUpdateStore.getState>['status']> = {}) => useUpdateStore.setState({
    status: {
      state: 'ready', availableVersion: '0.43.0', releaseNotes: null, releaseMessage: null, downloadProgress: 100,
      error: null, downloadPath: '/tmp/u', artifactUrl: 'https://example.invalid/u.zip', applyAttempted: false, ...extra,
    },
  });

  describe('UpdateBanner update gate', () => {
    const liveAgent: LiveAgentInfo = {
      agentId: 'update-agent', projectPath: 'project', orchestrator: 'claude-code',
      runtime: 'chat', isWorking: true, lastActivity: null, resumeStrategy: 'auto',
    };

    beforeEach(() => {
      resetStores();
      vi.useFakeTimers();
      useUpdateStore.setState({ status: { ...useUpdateStore.getState().status, state: 'ready' } });
      useAgentStore.setState({
        agents: { 'update-agent': {
          id: 'update-agent', name: 'Update agent', projectId: 'project', kind: 'durable', status: 'running', color: 'blue',
        } },
      });
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([liveAgent]);
    });

    afterEach(() => { vi.useRealTimers(); });

    async function openGate() {
      render(<UpdateBanner />);
      await act(async () => { fireEvent.click(screen.getByTestId('update-restart-btn')); });
    }

    it('distinguishes the Dispatcher controller and explains its actions and delayed resume', async () => {
      useDispatcherStore.setState({ state: {
        ...DISPATCHER_OFF, chatAgentId: 'chat', config: { id: 'work', name: 'Sage', color: 'blue', createdAt: '' },
      } });
      const work: LiveAgentInfo = { ...liveAgent, agentId: 'work', dispatcherRole: 'work' };
      const chat: LiveAgentInfo = { ...liveAgent, agentId: 'chat', dispatcherRole: 'chat', isWorking: false };
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([work, chat]);
      await openGate();
      expect(screen.getByText('Dispatcher controller')).toBeInTheDocument();
      expect(screen.getByText('Sage')).toBeInTheDocument();
      expect(screen.queryByText('work')).not.toBeInTheDocument();
      expect(screen.queryByText('chat')).not.toBeInTheDocument();
      expect(screen.getByText(/Interrupt or Stop now can end work in progress/)).toBeInTheDocument();
      expect(screen.getByText(/After restart it resumes when next needed/)).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })); });
      expect(window.clubhouse.app.resolveWorkingAgent).toHaveBeenCalledWith('work', 'interrupt');
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([{ ...work, isWorking: false }, chat]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByText('Resumes when next needed')).toBeInTheDocument();
      expect(screen.getByText('Auto-resume')).toBeInTheDocument();
    });

    it('checks a woken agent again after cancelling an earlier successful stop', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockResolvedValue({ status: 'resolved', isWorking: false });
      await openGate();
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([]);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop now' })); });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([liveAgent]);
      await act(async () => { fireEvent.click(screen.getByTestId('update-restart-btn')); });
      expect(screen.getByText('Update agent')).toBeInTheDocument();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
    });

    it('ignores a stale idle poll that finishes after a newer working poll', async () => {
      await openGate();
      let finishOld!: (agents: LiveAgentInfo[]) => void;
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      await act(async () => { finishOld([{ ...liveAgent, isWorking: false }]); });
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
    });

    it('does not let a late stop response from a cancelled gate hide a newly working agent', async () => {
      let finishStop!: (result: UpdateAgentActionResult) => void;
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockImplementation(() => new Promise((resolve) => { finishStop = resolve; }));
      await openGate();
      fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await act(async () => { fireEvent.click(screen.getByTestId('update-restart-btn')); });
      await act(async () => { finishStop({ status: 'resolved', isWorking: false }); });
      expect(screen.getByText('Update agent')).toBeInTheDocument();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
    });

    it('shows the main-process deadline result without the renderer deadline overwriting it', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve({
          status: 'timeout', isWorking: true, message: 'The agent did not become idle in time.',
        }), UPDATE_AGENT_ACTION_TIMEOUT_MS);
      }));
      await openGate();
      fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_AGENT_ACTION_TIMEOUT_MS + 2000); });
      expect(screen.getByRole('alert')).toHaveTextContent('The agent did not become idle in time.');
      expect(screen.getByRole('alert')).not.toHaveTextContent('Interrupt did not respond');
      expect(screen.getByRole('button', { name: 'Stop now' })).toBeEnabled();
    });

    it('keeps a stopping row until main confirms, including when polling no longer sees the runtime', async () => {
      let finish!: (result: UpdateAgentActionResult) => void;
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      await openGate();
      fireEvent.click(screen.getByRole('button', { name: 'Stop now' }));
      expect(screen.getByText('Stopping...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop now' })).toBeDisabled();
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByText('Update agent')).toBeInTheDocument();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();

      await act(async () => { finish({ status: 'resolved', isWorking: false }); });
      expect(screen.queryByText('Update agent')).not.toBeInTheDocument();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeEnabled();
      // A stale poll cannot put the stopped agent back in the gate.
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([liveAgent]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByText('Update agent')).not.toBeInTheDocument();
    });

    it('retains a timed-out stop row after polling loses the runtime and offers retry', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockResolvedValue({
        status: 'timeout', isWorking: false, message: 'Stopping took too long. Try Stop now again.',
      });
      await openGate();
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([]);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop now' })); });
      expect(screen.getByRole('alert')).toHaveTextContent('Stopping took too long');
      expect(screen.getByText('Update agent')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop now' })).toBeEnabled();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
    });

    it('shows a rejected IPC request and allows another action', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockRejectedValue(new Error('IPC failed'));
      await openGate();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })); });
      expect(screen.getByRole('alert')).toHaveTextContent('The request failed');
      expect(screen.getByRole('button', { name: 'Stop now' })).toBeEnabled();
    });

    it('bounds unresponsive IPC and offers Stop now after interrupt timeout', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockImplementation(() => new Promise(() => {}));
      await openGate();
      fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
      expect(screen.getByText('Interrupting...')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
      expect(window.clubhouse.app.resolveWorkingAgent).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_AGENT_ACTION_TIMEOUT_MS + 2000); });
      expect(screen.getByRole('alert')).toHaveTextContent('Interrupt did not respond in time');
      expect(screen.getByRole('button', { name: 'Stop now' })).toBeEnabled();
      expect(screen.getByTestId('update-gate-restart-btn')).toHaveAccessibleDescription(/Restart is unavailable/);
    });

    it('enables Restart after interrupt reaches idle', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockImplementation(async () => {
        vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([{ ...liveAgent, isWorking: false }]);
        return { status: 'resolved', isWorking: false };
      });
      await openGate();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })); });
      expect(screen.getByTestId('update-gate-restart-btn')).toBeEnabled();
      expect(screen.getByText('Auto-resume')).toBeInTheDocument();
    });

    it('clears an interrupt timeout if a later poll observes idle', async () => {
      vi.mocked(window.clubhouse.app.resolveWorkingAgent).mockResolvedValue({
        status: 'timeout', isWorking: true, message: 'The agent did not become idle in time.',
      });
      await openGate();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })); });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockResolvedValue([{ ...liveAgent, isWorking: false }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('update-gate-restart-btn')).toBeEnabled();
    });

    it('reports live-agent lookup failure instead of allowing an unchecked restart', async () => {
      vi.mocked(window.clubhouse.app.getLiveAgentsForUpdate).mockRejectedValueOnce(new Error('IPC failed'));
      await openGate();
      expect(screen.getByRole('alert')).toHaveTextContent('Could not check active agents');
      expect(screen.getByTestId('update-gate-restart-btn')).toBeDisabled();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Update agent')).toBeInTheDocument();
    });
  });

  it('renders the update-ready card with Restart, Download manually and Later', () => {
    ready();
    const openUpdateDownload = vi.fn();
    useUpdateStore.setState({ openUpdateDownload });
    render(<UpdateBanner variant="card" />);
    const card = screen.getByTestId('update-banner');
    expect(card).toHaveTextContent('Update ready');
    expect(card).toHaveTextContent('v0.43.0');
    expect(card.className).toContain('rounded-lg');
    expect(screen.getByTestId('update-restart-btn')).toHaveTextContent('Restart');
    fireEvent.click(screen.getByTestId('update-manual-download-btn'));
    expect(openUpdateDownload).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('update-dismiss-btn'));
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it('offers Download manually on the ready card only when there is an artifact', () => {
    ready({ artifactUrl: null });
    render(<UpdateBanner variant="card" />);
    expect(screen.queryByTestId('update-manual-download-btn')).toBeNull();
  });

  it('restarts straight away when no agents are running', () => {
    ready();
    render(<UpdateBanner variant="card" />);
    fireEvent.click(screen.getByTestId('update-restart-btn'));
    expect(window.clubhouse.app.confirmUpdateRestart).toHaveBeenCalled();
  });

  it('shows the retry card after a failed apply', () => {
    ready({ applyAttempted: true });
    render(<UpdateBanner variant="card" />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Update did not apply');
    expect(screen.getByTestId('update-restart-btn')).toHaveTextContent('Try again');
    expect(screen.getByTestId('update-manual-download-btn')).toBeInTheDocument();
  });

  it('shows the failure card with a manual download', () => {
    useUpdateStore.setState({
      status: {
        state: 'error', availableVersion: '0.43.0', releaseNotes: null, releaseMessage: null, downloadProgress: 0,
        error: 'Disk full', downloadPath: null, artifactUrl: 'https://example.invalid/u.zip', applyAttempted: false,
      },
    });
    render(<UpdateBanner variant="card" />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Update failed');
    expect(screen.getByTestId('update-error-message')).toHaveTextContent('Disk full');
    expect(screen.getByTestId('update-manual-download-btn')).toBeInTheDocument();
  });
});
