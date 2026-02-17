import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { usePluginStore } from '../../plugins/plugin-store';
import { PermissionViolationBanner } from './PermissionViolationBanner';

function resetStore() {
  usePluginStore.setState({
    plugins: {},
    projectEnabled: {},
    appEnabled: [],
    modules: {},
    safeModeActive: false,
    pluginSettings: {},
    permissionViolations: [],
  });
}

describe('PermissionViolationBanner', () => {
  beforeEach(resetStore);

  it('renders nothing when no violations', () => {
    const { container } = render(<PermissionViolationBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a red banner when there is a violation', () => {
    usePluginStore.setState({
      permissionViolations: [
        {
          pluginId: 'bad-plugin',
          pluginName: 'Bad Plugin',
          permission: 'git',
          apiName: 'git',
          timestamp: 1000,
        },
      ],
    });

    render(<PermissionViolationBanner />);

    const banner = screen.getByTestId('permission-violation-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('Bad Plugin')).toBeInTheDocument();
    expect(screen.getByText('api.git')).toBeInTheDocument();
    expect(screen.getByText('git')).toBeInTheDocument();
  });

  it('renders multiple banners for multiple violations', () => {
    usePluginStore.setState({
      permissionViolations: [
        {
          pluginId: 'plugin-a',
          pluginName: 'Plugin A',
          permission: 'git',
          apiName: 'git',
          timestamp: 1000,
        },
        {
          pluginId: 'plugin-b',
          pluginName: 'Plugin B',
          permission: 'files',
          apiName: 'files',
          timestamp: 2000,
        },
      ],
    });

    render(<PermissionViolationBanner />);

    const banners = screen.getAllByTestId('permission-violation-banner');
    expect(banners).toHaveLength(2);
  });

  it('dismiss hides banner and clears store', () => {
    usePluginStore.setState({
      permissionViolations: [
        {
          pluginId: 'bad-plugin',
          pluginName: 'Bad Plugin',
          permission: 'git',
          apiName: 'git',
          timestamp: 1000,
        },
      ],
    });

    render(<PermissionViolationBanner />);

    expect(screen.getByTestId('permission-violation-banner')).toBeInTheDocument();

    // Click dismiss
    fireEvent.click(screen.getByText('x'));

    // Banner should be gone
    expect(screen.queryByTestId('permission-violation-banner')).toBeNull();

    // Store should be cleared
    expect(usePluginStore.getState().permissionViolations).toHaveLength(0);
  });
});
