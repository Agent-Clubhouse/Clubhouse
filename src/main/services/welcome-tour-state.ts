import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createSettingsStore } from './settings-store';
import { normalizeWelcomeTourState, WELCOME_TOUR_DEFAULTS, type WelcomeTourState } from '../../shared/welcome-tour';

/**
 * Where the welcome tour got to (#2814): `welcome-tour.json`. It isn't a
 * person's setting, so it isn't audited, and nothing else reads it. The tour
 * writes this file and no other.
 */

let unreadable = false;

/**
 * What an earlier run leaves in userData, read before this launch writes
 * anything: the renderer's Local Storage (any earlier window), and the
 * settings files of features 0.42 had and 1.0 retired. Not the home folder,
 * which modules may create while loading, and not files an E2E profile is
 * seeded with, so a fresh profile still reads as new.
 */
export const EARLIER_RUN_MARKERS: readonly string[] = ['Local Storage', 'clubhouse-mode-settings.json', 'free-agent-settings.json'];

/** Null until noted, and when it couldn't be read. */
let earlierRun: boolean | null = null;

/**
 * Note whether Clubhouse ran here before. Call once at startup, after the
 * userData override and before any window opens. Only checks that files
 * exist; reads and deletes nothing.
 */
export function noteEarlierRun(userData: string = app.getPath('userData')): void {
  if (earlierRun !== null) return;
  try {
    earlierRun = EARLIER_RUN_MARKERS.some((name) => fs.existsSync(path.join(userData, name)));
  } catch {
    // telemetry-exempt: unknown, so the tour decides from its other signals.
    earlierRun = null;
  }
}

/** For tests. */
export function _resetEarlierRunForTesting(): void {
  earlierRun = null;
}

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

/**
 * The saved state, whether the file was there but couldn't be read, and
 * whether an earlier run left anything behind (undefined when not known).
 */
export function getWelcomeTourState(): { state: WelcomeTourState; unreadable: boolean; earlierRun?: boolean } {
  const state = normalizeWelcomeTourState(store.get());
  return { state, unreadable, ...(earlierRun !== null && { earlierRun }) };
}

export async function saveWelcomeTourState(next: unknown): Promise<WelcomeTourState> {
  const state = normalizeWelcomeTourState(next);
  await store.save(state);
  unreadable = false;
  return state;
}
