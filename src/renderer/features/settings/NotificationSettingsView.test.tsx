import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationSettingsView } from './NotificationSettingsView';
import { useNotificationStore } from '../../stores/notificationStore';
import { useBadgeSettingsStore } from '../../stores/badgeSettingsStore';
import { useBadgeStore } from '../../stores/badgeStore';

vi.mock('../../stores/badgeStore', () => ({
  useBadgeStore: Object.assign(vi.fn((sel: any) => sel({
    clearAll: vi.fn(),
  })), {
    getState: vi.fn(() => ({ clearAll: vi.fn() })),
  }),
}));

const mockLoadSettings = vi.fn().mockResolvedValue(undefined);
const mockSaveSettings = vi.fn().mockResolvedValue(undefined);
const mockLoadBadgeSettings = vi.fn().mockResolvedValue(undefined);
const mockSaveAppSettings = vi.fn().mockResolvedValue(undefined);
const mockSetProjectOverride = vi.fn().mockResolvedValue(undefined);
const mockClearProjectOverride = vi.fn().mockResolvedValue(undefined);

function resetStores(opts: { projectOverrides?: Record<string, any> } = {}) {
  useNotificationStore.setState({
    settings: {
      enabled: true,
      permissionNeeded: true,
      agentStopped: true,
      agentIdle: false,
      agentError: true,
      playSound: true,
    },
    loadSettings: mockLoadSettings,
    saveSettings: mockSaveSettings,
  });
  useBadgeSettingsStore.setState({
    enabled: true,
    pluginBadges: true,
    projectRailBadges: true,
    projectOverrides: opts.projectOverrides ?? {},
    loadSettings: mockLoadBadgeSettings,
    saveAppSettings: mockSaveAppSettings,
    setProjectOverride: mockSetProjectOverride,
    clearProjectOverride: mockClearProjectOverride,
  });
}

describe('NotificationSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state when settings are null', () => {
    useNotificationStore.setState({ settings: null, loadSettings: mockLoadSettings });
    useBadgeSettingsStore.setState({ loadSettings: mockLoadBadgeSettings });
    render(<NotificationSettingsView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders notification toggles in app context', () => {
    resetStores();
    render(<NotificationSettingsView />);
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Enable Notifications')).toBeInTheDocument();
    expect(screen.getByText('Permission Needed')).toBeInTheDocument();
    expect(screen.getByText('Agent Stopped')).toBeInTheDocument();
  });

  it('renders badge settings in project context', () => {
    resetStores();
    render(<NotificationSettingsView projectId="proj-1" />);
    expect(screen.getByText('Badges')).toBeInTheDocument();
    expect(screen.getByText('Enable Badges')).toBeInTheDocument();
  });

  describe('handleProjectToggle (badge override removal)', () => {
    it('clears all overrides when removing the last key', async () => {
      resetStores({
        projectOverrides: { 'proj-1': { enabled: false } },
      });
      render(<NotificationSettingsView projectId="proj-1" />);

      // Click "Global" on the Enable Badges tri-state toggle to reset to undefined
      const globalButtons = screen.getAllByText('Global');
      fireEvent.click(globalButtons[0]);

      await waitFor(() => {
        expect(mockClearProjectOverride).toHaveBeenCalledWith('proj-1');
      });
      // Should NOT call setProjectOverride since there are no remaining keys
      expect(mockSetProjectOverride).not.toHaveBeenCalled();
    });

    it('clears then re-sets remaining overrides when removing one key', async () => {
      resetStores({
        projectOverrides: { 'proj-1': { enabled: false, pluginBadges: false } },
      });
      render(<NotificationSettingsView projectId="proj-1" />);

      // Click "Global" on the Enable Badges toggle to clear the 'enabled' key
      const globalButtons = screen.getAllByText('Global');
      fireEvent.click(globalButtons[0]);

      await waitFor(() => {
        expect(mockClearProjectOverride).toHaveBeenCalledWith('proj-1');
      });
      await waitFor(() => {
        expect(mockSetProjectOverride).toHaveBeenCalledWith('proj-1', { pluginBadges: false });
      });
    });

    it('sets override directly when value is not undefined', () => {
      resetStores();
      render(<NotificationSettingsView projectId="proj-1" />);

      // Click "Off" on the Enable Badges toggle
      const offButtons = screen.getAllByText('Off');
      fireEvent.click(offButtons[0]);

      expect(mockSetProjectOverride).toHaveBeenCalledWith('proj-1', { enabled: false });
    });
  });
});
