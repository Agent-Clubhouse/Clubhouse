import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { OnboardingModal } from './OnboardingModal';

// Mock window.clubhouse and window.open
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      project: {
        pickDirectory: vi.fn().mockResolvedValue(null),
        loadProjects: vi.fn().mockResolvedValue([]),
      },
    },
    open: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
});

// Mock projectStore
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (s: any) => any) => selector({
    pickAndAddProject: vi.fn(),
  }),
}));

// Mock uiStore
const mockSetExplorerTab = vi.fn();
const mockSetSettingsSubPage = vi.fn();
const mockSetSettingsContext = vi.fn();
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: any) => any) => selector({
    setExplorerTab: mockSetExplorerTab,
    setSettingsSubPage: mockSetSettingsSubPage,
    setSettingsContext: mockSetSettingsContext,
  }),
}));

function resetStore() {
  useOnboardingStore.setState({
    showOnboarding: false,
    completed: false,
    cohort: null,
    step: 'cohort-select',
    highlightIndex: 0,
  });
  mockSetExplorerTab.mockClear();
  mockSetSettingsSubPage.mockClear();
  mockSetSettingsContext.mockClear();
}

describe('OnboardingModal', () => {
  beforeEach(resetStore);

  it('renders nothing when showOnboarding is false', () => {
    const { container } = render(<OnboardingModal />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the modal when showOnboarding is true', () => {
    useOnboardingStore.setState({ showOnboarding: true });
    render(<OnboardingModal />);
    expect(screen.getByTestId('onboarding-modal')).toBeInTheDocument();
  });

  it('shows cohort selection on initial step', () => {
    useOnboardingStore.setState({ showOnboarding: true, step: 'cohort-select' });
    render(<OnboardingModal />);
    expect(screen.getByTestId('cohort-selection')).toBeInTheDocument();
  });

  it('shows highlight carousel when step is highlights', () => {
    useOnboardingStore.setState({
      showOnboarding: true,
      step: 'highlights',
      cohort: 'new-dev',
      highlightIndex: 0,
    });
    render(<OnboardingModal />);
    expect(screen.getByTestId('highlight-carousel')).toBeInTheDocument();
  });

  it('shows get-started screen on final step', () => {
    useOnboardingStore.setState({ showOnboarding: true, step: 'get-started' });
    render(<OnboardingModal />);
    expect(screen.getByTestId('get-started-screen')).toBeInTheDocument();
  });

  it('skip button dismisses the modal', () => {
    useOnboardingStore.setState({ showOnboarding: true });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
    expect(useOnboardingStore.getState().completed).toBe(true);
  });

  it('clicking backdrop dismisses the modal', () => {
    useOnboardingStore.setState({ showOnboarding: true });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('onboarding-backdrop'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
  });

  it('clicking inside modal does not dismiss', () => {
    useOnboardingStore.setState({ showOnboarding: true });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('onboarding-modal'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(true);
  });

  it('Escape key dismisses the modal', () => {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    (window.addEventListener as any) = vi.fn((event: string, handler: any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    });
    (window.removeEventListener as any) = vi.fn((event: string, handler: any) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    });

    useOnboardingStore.setState({ showOnboarding: true });
    render(<OnboardingModal />);

    const handler = listeners['keydown']?.[0];
    expect(handler).toBeDefined();
    handler({ key: 'Escape' });

    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
  });

  it('selecting a cohort advances to highlights', () => {
    useOnboardingStore.setState({ showOnboarding: true, step: 'cohort-select' });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('cohort-new-dev'));

    const state = useOnboardingStore.getState();
    expect(state.cohort).toBe('new-dev');
    expect(state.step).toBe('highlights');
  });

  it('carousel next/prev navigates slides', () => {
    useOnboardingStore.setState({
      showOnboarding: true,
      step: 'highlights',
      cohort: 'experienced-dev',
      highlightIndex: 0,
    });
    render(<OnboardingModal />);

    // Next
    fireEvent.click(screen.getByTestId('carousel-next'));
    expect(useOnboardingStore.getState().highlightIndex).toBe(1);

    // Prev
    fireEvent.click(screen.getByTestId('carousel-prev'));
    expect(useOnboardingStore.getState().highlightIndex).toBe(0);
  });

  it('carousel dots reflect current index', () => {
    useOnboardingStore.setState({
      showOnboarding: true,
      step: 'highlights',
      cohort: 'new-dev',
      highlightIndex: 1,
    });
    render(<OnboardingModal />);

    const dot0 = screen.getByTestId('carousel-dot-0');
    const dot1 = screen.getByTestId('carousel-dot-1');
    const dot2 = screen.getByTestId('carousel-dot-2');

    expect(dot1.className).toContain('bg-ctp-accent');
    expect(dot0.className).toContain('bg-surface-2');
    expect(dot2.className).toContain('bg-surface-2');
  });

  it('help button dismisses modal and opens in-app help view', () => {
    useOnboardingStore.setState({ showOnboarding: true, step: 'get-started' });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('onboarding-help-btn'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
    expect(useOnboardingStore.getState().completed).toBe(true);
    expect(mockSetExplorerTab).toHaveBeenCalledWith('help');
  });

  it('extensibility button dismisses modal and opens plugins settings', () => {
    useOnboardingStore.setState({ showOnboarding: true, step: 'get-started' });
    render(<OnboardingModal />);

    fireEvent.click(screen.getByTestId('onboarding-extensibility-btn'));
    expect(useOnboardingStore.getState().showOnboarding).toBe(false);
    expect(useOnboardingStore.getState().completed).toBe(true);
    expect(mockSetExplorerTab).toHaveBeenCalledWith('settings');
    expect(mockSetSettingsContext).toHaveBeenCalledWith('app');
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('plugins');
  });
});
