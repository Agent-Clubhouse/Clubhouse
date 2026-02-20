import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useOnboardingStore } from './onboardingStore';

// Mock localStorage
const storage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { storage[key] = value; }),
  removeItem: vi.fn((key: string) => { delete storage[key]; }),
});

function resetStore() {
  delete storage['clubhouse_onboarding'];
  useOnboardingStore.setState({
    showOnboarding: false,
    completed: false,
    cohort: null,
    step: 'cohort-select',
    highlightIndex: 0,
  });
}

describe('onboardingStore', () => {
  beforeEach(resetStore);

  it('initialises with default values', () => {
    const state = useOnboardingStore.getState();
    expect(state.showOnboarding).toBe(false);
    expect(state.completed).toBe(false);
    expect(state.cohort).toBeNull();
    expect(state.step).toBe('cohort-select');
    expect(state.highlightIndex).toBe(0);
  });

  it('startOnboarding shows the modal and resets state', () => {
    useOnboardingStore.getState().startOnboarding();
    const state = useOnboardingStore.getState();
    expect(state.showOnboarding).toBe(true);
    expect(state.step).toBe('cohort-select');
    expect(state.highlightIndex).toBe(0);
    expect(state.cohort).toBeNull();
  });

  it('selectCohort sets cohort and moves to highlights step', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('new-dev');
    const state = useOnboardingStore.getState();
    expect(state.cohort).toBe('new-dev');
    expect(state.step).toBe('highlights');
    expect(state.highlightIndex).toBe(0);
  });

  it('nextHighlight increments index up to 2', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('experienced-dev');

    useOnboardingStore.getState().nextHighlight();
    expect(useOnboardingStore.getState().highlightIndex).toBe(1);

    useOnboardingStore.getState().nextHighlight();
    expect(useOnboardingStore.getState().highlightIndex).toBe(2);
  });

  it('nextHighlight at index 2 moves to get-started step', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('seasoned-dev');
    useOnboardingStore.setState({ highlightIndex: 2 });

    useOnboardingStore.getState().nextHighlight();
    expect(useOnboardingStore.getState().step).toBe('get-started');
  });

  it('prevHighlight decrements index', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('new-dev');
    useOnboardingStore.setState({ highlightIndex: 2 });

    useOnboardingStore.getState().prevHighlight();
    expect(useOnboardingStore.getState().highlightIndex).toBe(1);

    useOnboardingStore.getState().prevHighlight();
    expect(useOnboardingStore.getState().highlightIndex).toBe(0);
  });

  it('prevHighlight at index 0 returns to cohort-select', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('new-dev');

    useOnboardingStore.getState().prevHighlight();
    expect(useOnboardingStore.getState().step).toBe('cohort-select');
  });

  it('dismissOnboarding hides modal, marks completed, and persists', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('experienced-dev');
    useOnboardingStore.getState().dismissOnboarding();

    const state = useOnboardingStore.getState();
    expect(state.showOnboarding).toBe(false);
    expect(state.completed).toBe(true);

    // Check localStorage
    const persisted = JSON.parse(storage['clubhouse_onboarding']);
    expect(persisted.completed).toBe(true);
    expect(persisted.cohort).toBe('experienced-dev');
  });

  it('goToGetStarted jumps directly to get-started step', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().selectCohort('new-dev');
    useOnboardingStore.getState().goToGetStarted();

    expect(useOnboardingStore.getState().step).toBe('get-started');
  });

  it('resetOnboarding clears completed state and persists', () => {
    useOnboardingStore.getState().startOnboarding();
    useOnboardingStore.getState().dismissOnboarding();
    expect(useOnboardingStore.getState().completed).toBe(true);

    useOnboardingStore.getState().resetOnboarding();
    const state = useOnboardingStore.getState();
    expect(state.completed).toBe(false);
    expect(state.cohort).toBeNull();
    expect(state.showOnboarding).toBe(false);

    const persisted = JSON.parse(storage['clubhouse_onboarding']);
    expect(persisted.completed).toBe(false);
  });
});
