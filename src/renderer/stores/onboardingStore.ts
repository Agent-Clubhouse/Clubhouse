import { create } from 'zustand';

export type Cohort = 'new-dev' | 'experienced-dev' | 'seasoned-dev';

export type OnboardingStep = 'cohort-select' | 'highlights' | 'get-started';

const STORAGE_KEY = 'clubhouse_onboarding';

interface OnboardingPersisted {
  completed: boolean;
  cohort: Cohort | null;
}

function loadPersisted(): OnboardingPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { completed: false, cohort: null };
}

function savePersisted(data: OnboardingPersisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

interface OnboardingState {
  showOnboarding: boolean;
  completed: boolean;
  cohort: Cohort | null;
  step: OnboardingStep;
  highlightIndex: number;
  startOnboarding: () => void;
  dismissOnboarding: () => void;
  selectCohort: (cohort: Cohort) => void;
  nextHighlight: () => void;
  prevHighlight: () => void;
  goToGetStarted: () => void;
  resetOnboarding: () => void;
}

const persisted = loadPersisted();

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  showOnboarding: false,
  completed: persisted.completed,
  cohort: persisted.cohort,
  step: 'cohort-select',
  highlightIndex: 0,

  startOnboarding: () => {
    set({ showOnboarding: true, step: 'cohort-select', highlightIndex: 0, cohort: null });
  },

  dismissOnboarding: () => {
    const { cohort } = get();
    const data: OnboardingPersisted = { completed: true, cohort };
    savePersisted(data);
    set({ showOnboarding: false, completed: true });
  },

  selectCohort: (cohort) => {
    set({ cohort, step: 'highlights', highlightIndex: 0 });
  },

  nextHighlight: () => {
    const { highlightIndex } = get();
    if (highlightIndex < 2) {
      set({ highlightIndex: highlightIndex + 1 });
    } else {
      set({ step: 'get-started' });
    }
  },

  prevHighlight: () => {
    const { highlightIndex } = get();
    if (highlightIndex > 0) {
      set({ highlightIndex: highlightIndex - 1 });
    } else {
      set({ step: 'cohort-select' });
    }
  },

  goToGetStarted: () => {
    set({ step: 'get-started' });
  },

  resetOnboarding: () => {
    savePersisted({ completed: false, cohort: null });
    set({ completed: false, cohort: null, showOnboarding: false, step: 'cohort-select', highlightIndex: 0 });
  },
}));
