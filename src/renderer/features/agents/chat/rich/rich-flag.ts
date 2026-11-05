import { useEffect, useState } from 'react';
import { isGraduatedFlagOn } from '../../../../../shared/graduated-flags';

/** The experimental settings key for rich chat content (#2349). */
export const RICH_CHAT_CONTENT_FLAG = 'richChatContent';

let flagPromise: Promise<boolean> | null = null;
let flagValue: boolean | null = null;

export function loadRichChatContentFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.resolve()
      .then(() => window.clubhouse.app.getExperimentalSettings())
      .then((s) => isGraduatedFlagOn(s, RICH_CHAT_CONTENT_FLAG))
      .catch(() => false)
      .then((v) => { flagValue = v; return v; });
  }
  return flagPromise;
}

/** Forget the loaded flag (tests, the Rich chat content setting). */
export function resetRichChatContentFlag(): void {
  flagPromise = null;
  flagValue = null;
}

/** Whether rich chat content is on; false until the setting has loaded, so a saved off never shows rich content. */
export function useRichChatContent(): boolean {
  const [on, setOn] = useState<boolean>(() => flagValue === true);
  useEffect(() => {
    let cancelled = false;
    void loadRichChatContentFlag().then((v) => { if (!cancelled) setOn(v); });
    return () => { cancelled = true; };
  }, []);
  return on;
}
