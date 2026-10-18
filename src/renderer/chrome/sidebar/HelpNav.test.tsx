import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpNav } from './HelpNav';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useChromeFlagStore } from '../chromeFlag';

beforeEach(() => {
  useChromeFlagStore.setState({ enabled: true });
  useUIStore.setState({ explorerTab: 'help', helpSectionId: 'general', helpTopicId: null, helpSearchQuery: '' });
  usePluginStore.setState({ plugins: {}, appEnabled: [], projectEnabled: {} });
});
afterEach(() => useChromeFlagStore.setState({ enabled: false }));

describe('HelpNav', () => {
  it('lists the groups with the active one open on its first topic', () => {
    render(<HelpNav />);
    expect(screen.getByTestId('help-nav-section-general').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('help-nav-section-projects').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('help-nav-topic-getting-started').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByTestId('help-nav-topic-dashboard')).toBeNull();
  });

  it('expands a group and opens a topic', () => {
    render(<HelpNav />);
    fireEvent.click(screen.getByTestId('help-nav-section-projects'));
    fireEvent.click(screen.getByTestId('help-nav-topic-projects-settings'));
    expect(useUIStore.getState()).toMatchObject({ helpSectionId: 'projects', helpTopicId: 'projects-settings' });
    expect(screen.getByTestId('help-nav-topic-projects-settings').getAttribute('aria-current')).toBe('page');
  });

  it('replaces the groups with results while searching, and clears with Esc', () => {
    render(<HelpNav />);
    const input = screen.getByTestId('help-search');
    fireEvent.change(input, { target: { value: 'sidebar' } });
    expect(screen.queryByTestId('help-nav-section-general')).toBeNull();
    fireEvent.click(screen.getByTestId('help-nav-result-navigation'));
    expect(useUIStore.getState()).toMatchObject({ helpSectionId: 'general', helpTopicId: 'navigation' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUIStore.getState().helpSearchQuery).toBe('');
    expect(screen.getByTestId('help-nav-topic-navigation').getAttribute('aria-current')).toBe('page');
  });

  it('goes back to Agents on Esc in an empty search field', () => {
    useUIStore.setState({ explorerTab: 'help', previousExplorerTab: 'agents' });
    render(<HelpNav />);
    fireEvent.keyDown(screen.getByTestId('help-search'), { key: 'Escape' });
    expect(useUIStore.getState().explorerTab).toBe('agents');
  });

  it('explains retired layout words when nothing matches', () => {
    useUIStore.setState({ helpSearchQuery: 'accessory panel' });
    render(<HelpNav />);
    expect(screen.getByTestId('help-nav-empty').textContent).toMatch(/gone in this layout/);
  });

  it('lists enabled plugins under their own heading', () => {
    usePluginStore.setState({
      appEnabled: ['canvas'],
      plugins: { canvas: { status: 'activated', manifest: { id: 'canvas', name: 'Canvas', engine: { api: 0.5 }, contributes: { help: { topics: [{ id: 'canvas-intro', title: 'Using canvas', content: '# Canvas' }] } } } } } as never,
    });
    render(<HelpNav />);
    expect(screen.getAllByText('Plugins')).toHaveLength(2); // the built-in topic group and the heading above plugin groups
    expect(screen.getByTestId('help-nav-section-plugin:canvas')).toBeTruthy();
  });
});
