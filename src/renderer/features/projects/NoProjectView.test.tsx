import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../../stores/projectStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { NoProjectView } from './NoProjectView';

describe('NoProjectView', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, projectsLoaded: true });
    useChromeStore.setState({ lastProjectId: null });
  });

  it('offers Add Project on first run', () => {
    const pickAndAddProject = vi.fn();
    useProjectStore.setState({ pickAndAddProject });
    render(<NoProjectView />);
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Add Project'));
    expect(pickAndAddProject).toHaveBeenCalledOnce();
  });

  it('shows nothing before the project list loads, so first run does not flash', () => {
    useProjectStore.setState({ projectsLoaded: false });
    render(<NoProjectView />);
    expect(screen.queryByText('No projects yet')).toBeNull();
  });

  it('reopens the most recently active project, since there is no Home', () => {
    useChromeStore.setState({ lastProjectId: 'p2' });
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'p1', path: '/p1' }, { id: 'p2', name: 'p2', path: '/p2' }] });
    render(<NoProjectView />);
    expect(screen.queryByText('No projects yet')).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBe('p2');
  });

  it('falls back to the first project when the last one is gone', () => {
    useChromeStore.setState({ lastProjectId: 'removed' });
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'p1', path: '/p1' }] });
    render(<NoProjectView />);
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });
});
