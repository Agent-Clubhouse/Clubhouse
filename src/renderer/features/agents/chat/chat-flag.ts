import { useEffect, useState } from 'react';
import { isGraduatedFlagOn } from '../../../../shared/graduated-flags';

let flagPromise: Promise<boolean> | null = null;
/** The resolved flag, so panes mounted after the first load render the right view at once. */
let flagValue: boolean | null = null;

/** Same gate as main: Chat is on unless the flag is saved off. A read that fails shows the terminal. */
export function loadChatFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.resolve()
      .then(() => window.clubhouse.app.getExperimentalSettings())
      .then((s) => isGraduatedFlagOn(s, 'chat'))
      .catch(() => false)
      .then((v) => { flagValue = v; return v; });
  }
  return flagPromise;
}

/** Forget the loaded flag (tests, the Chat view setting). */
export function resetChatFlag(): void {
  flagPromise = null;
  flagValue = null;
}

/** The Chat flag, or null until it has loaded once this app session. */
export function useChatFlag(): boolean | null {
  const [on, setOn] = useState<boolean | null>(() => flagValue);
  useEffect(() => {
    let cancelled = false;
    void loadChatFlag().then((v) => { if (!cancelled) setOn(v); });
    return () => { cancelled = true; };
  }, []);
  return on;
}
