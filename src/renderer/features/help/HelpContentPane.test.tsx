import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { HelpView } from './HelpView';

describe('links between Help topics (#3344)', () => {
  beforeEach(() => {
    useUIStore.setState({ helpSectionId: 'agents', helpTopicId: 'agents-handoffs', helpSearchQuery: '' });
  });

  it.each([true, false])('opens the prepare-handoff skill from the Handoffs article, and back (new shell: %s)', (chrome) => {
    useChromeFlagStore.setState({ enabled: chrome });
    render(<HelpView />);
    fireEvent.click(screen.getByRole('link', { name: 'read the skill' }));
    expect(useUIStore.getState()).toMatchObject({ helpSectionId: 'agents', helpTopicId: 'agents-prepare-handoff' });
    const article = screen.getByText(/This is its exact text/).closest('article, .help-content')!;
    expect(article.textContent).toContain('name: prepare-handoff');
    expect(article.textContent).toContain('Call `offer_handoff`');
    fireEvent.click(screen.getByRole('link', { name: 'Back to Handoffs' }));
    expect(useUIStore.getState().helpTopicId).toBe('agents-handoffs');
  });

  it('leaves other links to the safe handler, and ignores a link to a topic that does not exist', () => {
    useChromeFlagStore.setState({ enabled: true });
    const openExternal = vi.fn();
    window.clubhouse.app.openExternalUrl = openExternal;
    useUIStore.setState({ helpSectionId: 'troubleshooting', helpTopicId: 'troubleshooting-common' });
    render(<HelpView />);
    const external = screen.getAllByRole('link').find((a) => a.getAttribute('href')?.startsWith('https://'));
    expect(external).toBeDefined();
    fireEvent.click(external!);
    expect(openExternal).toHaveBeenCalledWith(external!.getAttribute('href'));
    expect(useUIStore.getState().helpTopicId).toBe('troubleshooting-common');
  });
});
