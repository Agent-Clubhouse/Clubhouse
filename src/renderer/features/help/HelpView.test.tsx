import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { HelpView } from './HelpView';

vi.mock('./HelpSectionNav', () => ({
  HelpSectionNav: () => <div data-testid="help-section-nav" />,
}));
vi.mock('./HelpTopicList', () => ({
  HelpTopicList: () => <div data-testid="help-topic-list" />,
}));
vi.mock('./HelpContentPane', () => ({
  HelpContentPane: ({ markdown, variant }: { markdown: string | null; variant?: string }) => (
    <div data-testid="help-content-pane" data-variant={variant ?? 'classic'}>{markdown?.split('\n')[0]}</div>
  ),
}));
vi.mock('./HelpSearchResults', () => ({
  HelpSearchResults: () => <div data-testid="help-search-results" />,
}));

function resetStores() {
  useChromeFlagStore.setState({ enabled: false });
  useUIStore.setState({
    helpSectionId: 'general',
    helpTopicId: null,
    helpSearchQuery: '',
  });
  usePluginStore.setState({
    plugins: {},
    appEnabled: [],
    projectEnabled: {},
  });
}

describe('HelpView', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ assistant: true });
  });

  it('never shows the removed "Ask Assistant" button, even with a stale flag', async () => {
    render(<HelpView />);
    await waitFor(() => {
      expect(screen.getByTestId('help-section-nav')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('ask-assistant-button')).not.toBeInTheDocument();
  });

  it('classic: keeps the section and topic columns beside the article', () => {
    render(<HelpView />);
    expect(screen.getByTestId('help-section-nav')).toBeInTheDocument();
    expect(screen.getByTestId('help-topic-list')).toBeInTheDocument();
  });

  it('new shell: the pane is only the article, opening the first topic by default', () => {
    useChromeFlagStore.setState({ enabled: true });
    render(<HelpView />);
    expect(screen.queryByTestId('help-section-nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('help-topic-list')).not.toBeInTheDocument();
    const pane = screen.getByTestId('help-content-pane');
    expect(pane.dataset.variant).toBe('chrome');
    expect(pane.textContent).toBe('# Getting started');
  });

  it('new shell: shows the selected topic', () => {
    useChromeFlagStore.setState({ enabled: true });
    useUIStore.setState({ helpSectionId: 'general', helpTopicId: 'keyboard-shortcuts' });
    render(<HelpView />);
    expect(screen.getByTestId('help-content-pane').textContent).toBe('# Keyboard shortcuts');
  });
});
