import { create } from 'zustand';

/** Experimental flag id for the redesigned chrome (docs/chrome-redesign-spec.md §4.1). */
export const NEW_CHROME_FLAG = 'newChrome';

interface ChromeFlagState {
  /**
   * Whether the new chrome shell is active for this session. Read once at
   * startup and never changed while the app runs: switching layouts takes
   * effect on the next launch, so a session never mixes the two shells.
   */
  enabled: boolean;
}

export const useChromeFlagStore = create<ChromeFlagState>(() => ({ enabled: false }));

/** Reads the experimental flag once. Any failure leaves the legacy shell on. */
export async function loadChromeFlag(): Promise<boolean> {
  let enabled = false;
  try {
    const settings = await window.clubhouse.app.getExperimentalSettings();
    enabled = settings?.[NEW_CHROME_FLAG] === true;
  } catch {
    // telemetry-exempt: runs before the first render and before telemetry is connected; failing closed to the legacy shell is the handling
    enabled = false;
  }
  useChromeFlagStore.setState({ enabled });
  return enabled;
}

/** Non-hook accessor for code outside React (command actions, event bridge). */
export function isNewChromeEnabled(): boolean {
  return useChromeFlagStore.getState().enabled;
}
