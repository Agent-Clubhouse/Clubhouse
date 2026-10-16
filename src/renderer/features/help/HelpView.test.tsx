import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { HelpView } from './HelpView';

vi.mock('./HelpSectionNav', () => ({
  HelpSectionNav: () => <div data-testid="help-section-nav" />,
}));
vi.mock('./HelpTopicList', () => ({
  HelpTopicList: () => <div data-testid="help-topic-list" />,
}));
vi.mock('./HelpContentPane', () => ({
  HelpContentPane: () => <div data-testid="help-content-pane" />,
}));
vi.mock('./HelpSearchResults', () => ({
  HelpSearchResults: () => <div data-testid="help-search-results" />,
}));

function resetStores() {
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
});
