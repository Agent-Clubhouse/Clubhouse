import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUpdateStore } from '../../stores/updateStore';
import { WhatsNewDialog } from './WhatsNewDialog';

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
        getVersion: vi.fn().mockResolvedValue('0.27.0'),
        getPendingReleaseNotes: vi.fn().mockResolvedValue(null),
        clearPendingReleaseNotes: vi.fn().mockResolvedValue(undefined),
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
});

function resetStore() {
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
  });
}

describe('WhatsNewDialog', () => {
  beforeEach(resetStore);

  it('renders nothing when showWhatsNew is false', () => {
    const { container } = render(<WhatsNewDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when whatsNew is null', () => {
    useUpdateStore.setState({ showWhatsNew: true, whatsNew: null });
    const { container } = render(<WhatsNewDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the dialog with version and release notes', () => {
    useUpdateStore.setState({
      showWhatsNew: true,
      whatsNew: {
        version: '0.27.0',
        releaseNotes: '## Bug Fixes\n\n- Fixed crash on startup',
      },
    });

    render(<WhatsNewDialog />);

    expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument();
    expect(screen.getByText(/What's New in v0\.27\.0/)).toBeInTheDocument();
    expect(screen.getByText('Bug Fixes')).toBeInTheDocument();
    expect(screen.getByText(/Fixed crash on startup/)).toBeInTheDocument();
  });

  it('Got it button dismisses the dialog', () => {
    useUpdateStore.setState({
      showWhatsNew: true,
      whatsNew: {
        version: '0.27.0',
        releaseNotes: 'Some notes',
      },
    });

    render(<WhatsNewDialog />);

    fireEvent.click(screen.getByTestId('whats-new-got-it'));

    // Dialog should be removed from state
    const state = useUpdateStore.getState();
    expect(state.showWhatsNew).toBe(false);
    expect(state.whatsNew).toBeNull();
  });

  it('Escape key dismisses the dialog', () => {
    // We need real event listeners for the escape key test
    const listeners: Record<string, ((e: any) => void)[]> = {};
    (window.addEventListener as any) = vi.fn((event: string, handler: any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    });
    (window.removeEventListener as any) = vi.fn((event: string, handler: any) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    });

    useUpdateStore.setState({
      showWhatsNew: true,
      whatsNew: {
        version: '0.27.0',
        releaseNotes: 'Some notes',
      },
    });

    render(<WhatsNewDialog />);

    // Simulate Escape key
    const handler = listeners['keydown']?.[0];
    expect(handler).toBeDefined();
    handler({ key: 'Escape' });

    const state = useUpdateStore.getState();
    expect(state.showWhatsNew).toBe(false);
  });

  it('clicking backdrop dismisses the dialog', () => {
    useUpdateStore.setState({
      showWhatsNew: true,
      whatsNew: {
        version: '0.27.0',
        releaseNotes: 'Some notes',
      },
    });

    render(<WhatsNewDialog />);

    fireEvent.click(screen.getByTestId('whats-new-backdrop'));

    const state = useUpdateStore.getState();
    expect(state.showWhatsNew).toBe(false);
  });

  it('clicking inside the dialog does not dismiss', () => {
    useUpdateStore.setState({
      showWhatsNew: true,
      whatsNew: {
        version: '0.27.0',
        releaseNotes: 'Some notes',
      },
    });

    render(<WhatsNewDialog />);

    fireEvent.click(screen.getByTestId('whats-new-dialog'));

    const state = useUpdateStore.getState();
    expect(state.showWhatsNew).toBe(true);
    expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument();
  });
});
