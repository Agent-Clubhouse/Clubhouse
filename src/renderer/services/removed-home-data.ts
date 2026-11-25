/**
 * Data the removed Home view (#2943) left in localStorage: the old Display
 * preference (`clubhouse_view_prefs`, only ever `showHome`) and a saved
 * binding for the removed Go to Home shortcut. Both are dead; this removes them.
 */
import { rendererLog } from '../plugins/renderer-logger';

export const VIEW_PREFS_KEY = 'clubhouse_view_prefs';
export const SHORTCUT_OVERRIDES_KEY = 'clubhouse_keyboard_shortcut_overrides';
export const REMOVED_SHORTCUT_IDS: readonly string[] = ['go-home'];

/** Returns the keys it changed. Best-effort: a storage failure leaves the dead values in place. */
export function removeHomeViewData(storage: Storage = localStorage): string[] {
  const changed: string[] = [];
  try {
    if (storage.getItem(VIEW_PREFS_KEY) !== null) {
      storage.removeItem(VIEW_PREFS_KEY);
      changed.push(VIEW_PREFS_KEY);
    }
  } catch { /* ignore */ }
  try {
    const raw = storage.getItem(SHORTCUT_OVERRIDES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const overrides = { ...(parsed as Record<string, unknown>) };
      let dropped = false;
      for (const id of REMOVED_SHORTCUT_IDS) {
        if (id in overrides) {
          delete overrides[id];
          dropped = true;
        }
      }
      if (dropped) {
        storage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify(overrides));
        changed.push(SHORTCUT_OVERRIDES_KEY);
      }
    }
  } catch { /* corrupt or unavailable: the shortcuts store ignores unknown ids anyway */ }
  if (changed.length > 0) {
    rendererLog('core:startup', 'info', 'Removed data left by the Home view', { meta: { keys: changed } });
  }
  return changed;
}
