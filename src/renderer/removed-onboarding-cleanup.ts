import { rendererLog } from './plugins/renderer-logger';

/**
 * The classic onboarding modal (experience-level question and slides) was
 * removed. Its only saved state was this one localStorage key, which nothing
 * reads any more, so startup deletes it. Exact key only, never a pattern.
 */
export const REMOVED_ONBOARDING_STORAGE_KEY = 'clubhouse_onboarding';

/**
 * Delete the saved onboarding state if it is there. Safe to run on every
 * startup: once the key is gone it does nothing and logs nothing. Never throws.
 * Returns true when it deleted the key.
 */
export function cleanupRemovedOnboardingState(storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage): boolean {
  try {
    if (storage.getItem(REMOVED_ONBOARDING_STORAGE_KEY) === null) return false;
    storage.removeItem(REMOVED_ONBOARDING_STORAGE_KEY);
    rendererLog('core:startup', 'info', 'Deleted saved onboarding state (the onboarding modal was removed)', {
      meta: { key: REMOVED_ONBOARDING_STORAGE_KEY },
    });
    return true;
  } catch (err) {
    rendererLog('core:startup', 'warn', 'Could not delete saved onboarding state', {
      meta: { key: REMOVED_ONBOARDING_STORAGE_KEY, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
