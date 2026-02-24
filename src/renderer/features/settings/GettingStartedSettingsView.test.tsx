import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { GettingStartedSettingsView } from './GettingStartedSettingsView';

function resetStore() {
  useOnboardingStore.setState({
    showOnboarding: false,
    completed: false,
    cohort: null,
    step: 'cohort-select',
    highlightIndex: 0,
  });
}

describe('GettingStartedSettingsView', () => {
  beforeEach(resetStore);

  it('renders the settings view', () => {
    render(<GettingStartedSettingsView />);
    expect(screen.getByTestId('getting-started-settings')).toBeInTheDocument();
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });

  it('shows "Start" button when onboarding not completed', () => {
    render(<GettingStartedSettingsView />);
    expect(screen.getByTestId('show-onboarding-btn')).toHaveTextContent('Start');
  });

  it('shows "Show Again" button when onboarding is completed', () => {
    useOnboardingStore.setState({ completed: true });
    render(<GettingStartedSettingsView />);
    expect(screen.getByTestId('show-onboarding-btn')).toHaveTextContent('Show Again');
  });

  it('clicking the button triggers startOnboarding', () => {
    render(<GettingStartedSettingsView />);
    fireEvent.click(screen.getByTestId('show-onboarding-btn'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(true);
  });

  it('does not show learning track topics', () => {
    useOnboardingStore.setState({ cohort: 'new-dev' });
    render(<GettingStartedSettingsView />);
    expect(screen.queryByTestId('getting-started-topics')).not.toBeInTheDocument();
  });
});
