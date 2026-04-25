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

describe('HelpView Ask Assistant button gating', () => {
  beforeEach(() => {
    resetStores();
    vi.clearAllMocks();
  });

  it('hides "Ask Assistant" button when experimental.assistant is off', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({});
    render(<HelpView />);
    await waitFor(() => {
      expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ask-assistant-button')).not.toBeInTheDocument();
  });

  it('shows "Ask Assistant" button when experimental.assistant is on', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockResolvedValue({ assistant: true });
    render(<HelpView />);
    await waitFor(() => {
      expect(screen.getByTestId('ask-assistant-button')).toBeInTheDocument();
    });
  });

  it('hides "Ask Assistant" button when the flag fetch rejects', async () => {
    window.clubhouse.app.getExperimentalSettings = vi.fn().mockRejectedValue(new Error('IPC down'));
    render(<HelpView />);
    await waitFor(() => {
      expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ask-assistant-button')).not.toBeInTheDocument();
  });
});
