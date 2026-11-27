import { createSettingsStore } from './settings-store';
import { normalizeWelcomeTourState, WELCOME_TOUR_DEFAULTS, type WelcomeTourState } from '../../shared/welcome-tour';

/**
 * Where the welcome tour got to (#2814): `welcome-tour.json`. It isn't a
 * person's setting, so it isn't audited, and nothing else reads it. The tour
 * writes this file and no other.
 */

let unreadable = false;

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

const store = createSettingsStore<WelcomeTourState>(
  'welcome-tour.json',
  WELCOME_TOUR_DEFAULTS,
  (raw) => normalizeWelcomeTourState(raw),
  {
    // A file that is there but can't be read counts as unreadable, so the tour
    // treats the person as upgrading (that never hides existing work). A
    // missing file is the ordinary first launch.
    onLoad: (result) => { unreadable = 'error' in result && !isMissingFile(result.error); },
  },
);

/** The saved state, and whether the file was there but couldn't be read. */
export function getWelcomeTourState(): { state: WelcomeTourState; unreadable: boolean } {
  const state = normalizeWelcomeTourState(store.get());
  return { state, unreadable };
}

export async function saveWelcomeTourState(next: unknown): Promise<WelcomeTourState> {
  const state = normalizeWelcomeTourState(next);
  await store.save(state);
  unreadable = false;
  return state;
}
