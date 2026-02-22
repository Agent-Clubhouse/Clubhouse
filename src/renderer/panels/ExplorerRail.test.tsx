import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { ExplorerRail } from './ExplorerRail';
import type { Project } from '../../shared/types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'test-project',
    path: '/home/user/test-project',
    ...overrides,
  };
}

function resetStores() {
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
    projectIcons: {},
  });
  useUIStore.setState({
    explorerTab: 'settings',
    settingsContext: 'app',
  });
}

describe('SettingsContextPicker (via ExplorerRail)', () => {
  beforeEach(resetStores);

  it('renders project initials when no icon is set', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      projectIcons: {},
    });

    render(<ExplorerRail />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders project icon image when icon override is set', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha', icon: 'custom.png' })],
      projectIcons: { p1: 'data:image/png;base64,abc123' },
    });

    render(<ExplorerRail />);
    const img = screen.getByRole('img', { name: 'Alpha' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
  });

  it('falls back to initials when icon field is set but data URL is missing', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Beta', icon: 'custom.png' })],
      projectIcons: {},
    });

    render(<ExplorerRail />);
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('uses project color for initials background', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Gamma', color: 'emerald' })],
      projectIcons: {},
    });

    render(<ExplorerRail />);
    const initial = screen.getByText('G');
    // emerald hex is #10b981, appended 20 (hex) = ~12.5% opacity
    expect(initial.closest('span')).toHaveStyle({ color: '#10b981' });
  });

  it('uses displayName over name for initials', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'original', displayName: 'Custom Name' })],
      projectIcons: {},
    });

    render(<ExplorerRail />);
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('Custom Name')).toBeInTheDocument();
  });
});
