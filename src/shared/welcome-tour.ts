/**
 * The 1.0 welcome tour's own saved state (#2814). Main keeps it in
 * `welcome-tour.json`, apart from every setting: it records where the tour got
 * to, never a choice that changes how the app behaves.
 */

/**
 * Raise this only when the tour changes enough that everyone should see it
 * again. It shows once per tour version, not once per app version.
 */
export const WELCOME_TOUR_VERSION = 1;

/** Who the tour is for: someone new, or someone coming from 0.42 or earlier (or an earlier beta). */
export type WelcomeTourVariant = 'new' | 'upgrade';

export interface WelcomeTourState {
  /** The tour version last finished or skipped. 0 means never. */
  seenVersion: number;
  /**
   * Who the tour was decided for, the first time it opened for `variantVersion`.
   * Kept so a relaunch mid-tour, and reopening it later, keep the same audience.
   */
  variant: WelcomeTourVariant | null;
  variantVersion: number;
}

export const WELCOME_TOUR_DEFAULTS: WelcomeTourState = { seenVersion: 0, variant: null, variantVersion: 0 };

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Keep only the fields the tour knows, each in range. Anything else reads as the default. */
export function normalizeWelcomeTourState(raw: unknown): WelcomeTourState {
  if (!raw || typeof raw !== 'object') return { ...WELCOME_TOUR_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const variant = r.variant === 'new' || r.variant === 'upgrade' ? r.variant : null;
  return {
    seenVersion: wholeNumber(r.seenVersion),
    variant,
    variantVersion: variant ? wholeNumber(r.variantVersion) : 0,
  };
}
