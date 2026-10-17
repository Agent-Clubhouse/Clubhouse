import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, createEvent } from '@testing-library/react';
import { Modal } from '../../components/Modal';
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
    expect(screen.getByTestId('command-palette-overlay')).toBeInTheDocument();
  });

  it('shows projects and agents in results when open', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    expect(screen.getAllByText('my-project').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Another Project')).toBeInTheDocument();
    expect(screen.getByText('curious-tapir')).toBeInTheDocument();
  });

  it('filters results based on query', () => {
    useCommandPaletteStore.setState({ isOpen: true, query: 'tapir', mode: 'all' });
    render(<CommandPalette />);
    // Agent name is highlighted so text is split across spans - check the option exists
    const options = screen.getAllByRole('option');
    const agentOption = options.find((el) => el.textContent?.includes('curious-tapir'));
    expect(agentOption).toBeDefined();
  });

  it('shows no results message for unmatched query', () => {
    useCommandPaletteStore.setState({ isOpen: true, query: 'xyznonexistent' });
    render(<CommandPalette />);
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
  });

  it('closes on backdrop click', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const backdrop = screen.getByTestId('command-palette-overlay').firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('closes on Escape key via overlay onKeyDown', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const overlay = screen.getByTestId('command-palette-overlay');
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('closes on Escape when fired from input (bubbles to overlay)', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('navigates selection with arrow keys', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const overlay = screen.getByTestId('command-palette-overlay');
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
    fireEvent.keyDown(overlay, { key: 'ArrowDown' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(1);
    fireEvent.keyDown(overlay, { key: 'ArrowUp' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  it('is a modal dialog with the search field as a combobox over the results', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    const active = input.getAttribute('aria-activedescendant');
    expect(active && document.getElementById(active)).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps Tab inside the dialog', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
  });

  it('keeps Tab in the palette when it is open over a Modal', () => {
    render(
      <>
        <Modal open onClose={() => {}} title="Under"><button type="button">Inside modal</button></Modal>
        <CommandPalette />
      </>,
    );
    act(() => useCommandPaletteStore.setState({ isOpen: true }));
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByText('Inside modal')).not.toHaveFocus();
  });

  it('leaves an Esc that a menu above already handled', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const input = screen.getByRole('combobox');
    const event = createEvent.keyDown(input, { key: 'Escape' });
    event.preventDefault();
    fireEvent(input, event);
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('groups in sentence case, with prefix hints in the footer', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    render(<CommandPalette />);
    const groups = screen.getAllByTestId('command-palette-group').map((g) => g.textContent);
    expect(groups).toContain('Agents');
    expect(groups).not.toContain('Spaces');
    for (const g of screen.getAllByTestId('command-palette-group')) expect(g.className).not.toMatch(/uppercase/);
    expect(screen.getByTestId('command-palette-hints').textContent).toContain('#canvases');
  });

  it('adds matching help topics as a small group', () => {
    useCommandPaletteStore.setState({ isOpen: true, query: 'keyboard', mode: 'all' });
    render(<CommandPalette />);
    const groups = screen.getAllByTestId('command-palette-group').map((g) => g.textContent);
    expect(groups).toContain('Help');
  });

  it('shows the mode as a label when a prefix is typed', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('#');
    render(<CommandPalette />);
    expect(screen.getByTestId('command-palette-mode').textContent).toBe('Canvases');
  });

  it('sets mode to agents with @ prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('@tap');
    expect(useCommandPaletteStore.getState().mode).toBe('agents');
  });

  it('sets mode to canvases with # prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('#hub');
    expect(useCommandPaletteStore.getState().mode).toBe('canvases');
  });

  it('sets mode to projects with / prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('/proj');
    expect(useCommandPaletteStore.getState().mode).toBe('projects');
  });

  it('sets mode to commands with > prefix', () => {
    useCommandPaletteStore.setState({ isOpen: true });
    useCommandPaletteStore.getState().setQuery('>set');
    expect(useCommandPaletteStore.getState().mode).toBe('commands');
  });
});
