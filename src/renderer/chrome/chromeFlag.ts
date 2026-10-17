import { create } from 'zustand';

export { NEW_CHROME_FLAG } from '../../shared/chrome-flag';

/**
 * Whether the new chrome shell is active for this session. Main passes the
 * experimental flag to the main window as a launch argument and preload exposes
 * it synchronously, so the shell is known before the first render with no IPC
 * on the startup path. Switching layouts takes effect on the next launch, so a
 * session never mixes the two shells (docs/chrome-redesign-spec.md §4.1).
 */
function readLaunchFlag(): boolean {
  return (globalThis as { clubhouse?: { newChromeLayout?: unknown } }).clubhouse?.newChromeLayout === true;
}

interface ChromeFlagState {
  enabled: boolean;
}

export const useChromeFlagStore = create<ChromeFlagState>(() => ({ enabled: readLaunchFlag() }));

/** Non-hook accessor for code outside React (command actions, stores). */
export function isNewChromeEnabled(): boolean {
  return useChromeFlagStore.getState().enabled;
}
