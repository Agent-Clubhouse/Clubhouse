import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { AccessoryPanel } from './AccessoryPanel';

function resetStores() {
  useUIStore.setState({
    explorerTab: 'settings',
    settingsContext: 'app',
    settingsSubPage: 'about',
  });
}

describe('SettingsCategoryNav (via AccessoryPanel)', () => {
  beforeEach(resetStores);

  it('settings category nav is scrollable when content overflows', () => {
    const { container } = render(<AccessoryPanel />);
    const nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();
    expect(nav!.className).toContain('overflow-y-auto');
    expect(nav!.className).toContain('min-h-0');
  });

  it('shows Experimental nav item on beta builds', async () => {
    vi.mocked(window.clubhouse.app.getVersion).mockResolvedValue('0.36.0-beta.2');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('hides Experimental nav item on stable builds', async () => {
    vi.mocked(window.clubhouse.app.getVersion).mockResolvedValue('1.0.0');
    const { unmount } = render(<AccessoryPanel />);
    // Wait for the version check to resolve
    await waitFor(() => {
      expect(window.clubhouse.app.getVersion).toHaveBeenCalled();
    });
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    unmount();
  });

  it('shows Experimental nav item on rc builds', async () => {
    vi.mocked(window.clubhouse.app.getVersion).mockResolvedValue('0.37.0-rc.1');
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });
});
