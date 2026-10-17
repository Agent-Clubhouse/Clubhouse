import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppNotices, CollapsedSidebarNotices } from './AppNotices';
import { usePluginStore } from '../../plugins/plugin-store';
import { useChromeStore } from '../../chrome/chromeStore';

const violation = { pluginId: 'p', pluginName: 'Bad Plugin', permission: 'git', apiName: 'git', timestamp: 1 };

describe('AppNotices', () => {
  beforeEach(() => {
    usePluginStore.setState({ permissionViolations: [] });
    useChromeStore.setState({ sidebarCollapsed: false });
  });

  it('stacks notices as cards in the sidebar slot', () => {
    usePluginStore.setState({ permissionViolations: [violation] });
    render(<AppNotices variant="card" />);
    const slot = screen.getByTestId('sidebar-notices');
    expect(slot).toContainElement(screen.getByTestId('permission-violation-banner'));
    expect(screen.getByTestId('permission-violation-banner').className).toContain('rounded-lg');
  });

  it('renders an empty slot when there is nothing to show', () => {
    render(<AppNotices variant="card" />);
    expect(screen.getByTestId('sidebar-notices')).toBeEmptyDOMElement();
  });

  it('shows the bars only while the sidebar is collapsed', () => {
    usePluginStore.setState({ permissionViolations: [violation] });
    const { rerender } = render(<CollapsedSidebarNotices />);
    expect(screen.queryByTestId('permission-violation-banner')).toBeNull();
    useChromeStore.setState({ sidebarCollapsed: true });
    rerender(<CollapsedSidebarNotices />);
    expect(screen.getByTestId('permission-violation-banner').className).toContain('border-b');
  });
});
