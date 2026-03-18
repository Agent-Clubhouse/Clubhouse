import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { useUpdateStore } from '../stores/updateStore';
import { AccessoryPanel } from './AccessoryPanel';

function resetStores(opts: { previewChannel?: boolean } = {}) {
  useUIStore.setState({
    explorerTab: 'settings',
    settingsContext: 'app',
    settingsSubPage: 'about',
  });
  useUpdateStore.setState({
    settings: {
      autoUpdate: true,
      previewChannel: opts.previewChannel ?? false,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    },
  });
}

describe('SettingsCategoryNav (via AccessoryPanel)', () => {
  beforeEach(() => resetStores());

  it('settings category nav is scrollable when content overflows', () => {
    const { container } = render(<AccessoryPanel />);
    const nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();
    expect(nav!.className).toContain('overflow-y-auto');
    expect(nav!.className).toContain('min-h-0');
  });

  it('shows Experimental nav item on beta builds', async () => {
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('0.36.0-beta.2');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('hides Experimental nav item on stable builds without preview channel', async () => {
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('1.0.0');
    const { unmount } = render(<AccessoryPanel />);
    // Wait for the version check to resolve
    await waitFor(() => {
      expect(window.clubhouse.app.getVersion).toHaveBeenCalled();
    });
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    unmount();
  });

  it('shows Experimental nav item on rc builds', async () => {
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('0.37.0-rc.1');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('shows Experimental nav item on stable builds when preview channel is enabled', async () => {
    resetStores({ previewChannel: true });
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('0.36.0');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('hides Experimental nav item on stable builds when preview channel is disabled', async () => {
    resetStores({ previewChannel: false });
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('0.36.0');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(window.clubhouse.app.getVersion).toHaveBeenCalled();
    });
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    unmount();
  });

  it('shows External Editor nav item in app settings', async () => {
    window.clubhouse.app.getVersion = vi.fn().mockResolvedValue('1.0.0');
    render(<AccessoryPanel />);
    expect(screen.getByText('External Editor')).toBeInTheDocument();
  });
});
