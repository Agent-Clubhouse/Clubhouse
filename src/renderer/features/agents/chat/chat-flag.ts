import { useEffect, useState } from 'react';

let flagPromise: Promise<boolean> | null = null;
/** The resolved flag, so panes mounted after the first load render the right view at once. */
let flagValue: boolean | null = null;

/** Same gate as main: the Chat flag only counts in preview-eligible builds. */
export function loadChatFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.all([window.clubhouse.app.getExperimentalSettings(), window.clubhouse.app.isPreviewEligible()])
      .then(([s, eligible]) => s?.chat === true && eligible === true)
      .catch(() => false)
      .then((v) => { flagValue = v; return v; });
  }
  return flagPromise;
}

/** Forget the loaded flag (tests, the Experimental settings toggle). */
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
