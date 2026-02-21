import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';

// Ensure platform is available
if (!(window as any).clubhouse) (window as any).clubhouse = {};
(window as any).clubhouse.platform = 'darwin';

describe('CommandPalette', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({
      isOpen: false,
      query: '',
      mode: 'all',
      selectedIndex: 0,
      recentCommands: [],
    });
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'my-project', path: '/home/user/my-project' },
        { id: 'p2', name: 'another-proj', path: '/home/user/another-proj', displayName: 'Another Project' },
      ],
      activeProjectId: 'p1',
    });
    useAgentStore.setState({
      agents: {
        'agent-1': {
          name: 'curious-tapir',
          projectId: 'p1',
          status: 'running',
          kind: 'durable',
        } as any,
      },
    });
  });

  it('renders nothing when closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
  });

  it('renders overlay when open', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    expect(screen.getByTestId('command-palette-overlay')).toBeTruthy();
  });

  it('shows projects and agents in results when open', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    expect(screen.getAllByText('my-project').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Another Project')).toBeTruthy();
    expect(screen.getByText('curious-tapir')).toBeTruthy();
  });

  it('filters results based on query', () => {
    useCommandPaletteStore.setState({ isOpen: true, query: 'tapir', mode: 'all' });
    render(<CommandPalette />);
    // Agent name is highlighted so text is split across spans - check the option exists
    const options = screen.getAllByRole('option');
    const agentOption = options.find((el) => el.textContent?.includes('curious-tapir'));
    expect(agentOption).toBeTruthy();
  });

  it('shows no results message for unmatched query', () => {
    useCommandPaletteStore.setState({ isOpen: true, query: 'xyznonexistent' });
    render(<CommandPalette />);
    expect(screen.getByText(/No results found/)).toBeTruthy();
  });

  it('closes on backdrop click', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const backdrop = screen.getByTestId('command-palette-overlay').firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('closes on Escape key', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('navigates selection with arrow keys', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(1);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  it('sets mode to agents with @ prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('@tap');
    expect(useCommandPaletteStore.getState().mode).toBe('agents');
  });

  it('sets mode to projects with # prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('#proj');
    expect(useCommandPaletteStore.getState().mode).toBe('projects');
  });

  it('sets mode to commands with > prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('>set');
    expect(useCommandPaletteStore.getState().mode).toBe('commands');
  });
});
