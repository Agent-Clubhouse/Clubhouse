import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUpdateStore } from '../../stores/updateStore';
import { WhatsNewSettingsView } from './WhatsNewSettingsView';

// Mock window.clubhouse
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
        getVersion: vi.fn().mockResolvedValue('0.29.0'),
        getPendingReleaseNotes: vi.fn().mockResolvedValue(null),
        clearPendingReleaseNotes: vi.fn().mockResolvedValue(undefined),
        getVersionHistory: vi.fn().mockResolvedValue({ markdown: '', entries: [] }),
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
});

// No-op to prevent useEffect from overwriting pre-set state
const noopLoad = vi.fn();

function resetStore(overrides?: Partial<ReturnType<typeof useUpdateStore.getState>>) {
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
    whatsNew: null,
    showWhatsNew: false,
    versionHistoryMarkdown: null,
    versionHistoryEntries: [],
    versionHistoryLoading: false,
    versionHistoryError: null,
    // Override loadVersionHistory to prevent useEffect from resetting state
    loadVersionHistory: noopLoad,
    ...overrides,
  });
}

describe('WhatsNewSettingsView', () => {
  beforeEach(() => resetStore());

  it('renders the page header', () => {
    render(<WhatsNewSettingsView />);
    expect(screen.getByText("What's New")).toBeInTheDocument();
    expect(screen.getByText(/Release notes for recent versions/)).toBeInTheDocument();
  });

  it('shows loading state', () => {
    resetStore({ versionHistoryLoading: true });
    render(<WhatsNewSettingsView />);
    expect(screen.getByTestId('whats-new-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading version history...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    resetStore({
      versionHistoryError: 'Network error',
      versionHistoryLoading: false,
    });
    render(<WhatsNewSettingsView />);
    expect(screen.getByTestId('whats-new-error')).toBeInTheDocument();
    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it('shows empty state when no history available', () => {
    resetStore({
      versionHistoryMarkdown: null,
      versionHistoryLoading: false,
      versionHistoryError: null,
    });
    render(<WhatsNewSettingsView />);
    expect(screen.getByTestId('whats-new-empty')).toBeInTheDocument();
    expect(screen.getByText('No version history available.')).toBeInTheDocument();
  });

  it('renders markdown content when history is loaded', () => {
    resetStore({
      versionHistoryMarkdown: '# Great Release\n\n## New Features\n\n- Added widget',
      versionHistoryEntries: [{
        version: '0.29.0',
        releaseDate: new Date().toISOString(),
        releaseMessage: 'Great Release',
        releaseNotes: '## New Features\n\n- Added widget',
      }],
      versionHistoryLoading: false,
    });
    render(<WhatsNewSettingsView />);
    expect(screen.getByTestId('whats-new-content')).toBeInTheDocument();
    expect(screen.getByText('Great Release')).toBeInTheDocument();
    expect(screen.getByText('New Features')).toBeInTheDocument();
  });

  it('does not show loading or error when content is present', () => {
    resetStore({
      versionHistoryMarkdown: '# Release\n\nContent',
      versionHistoryLoading: false,
      versionHistoryError: null,
    });
    render(<WhatsNewSettingsView />);
    expect(screen.queryByTestId('whats-new-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-empty')).not.toBeInTheDocument();
  });

  it('calls loadVersionHistory on mount', () => {
    render(<WhatsNewSettingsView />);
    expect(noopLoad).toHaveBeenCalled();
  });
});
