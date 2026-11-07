import { useEffect, useState } from 'react';

let flagPromise: Promise<boolean> | null = null;
let flagValue: boolean | null = null;

/** Clubhouse-managed agents (#2819) show only with the preview flag on while the epic lands. */
export function loadManagedFlag(): Promise<boolean> {
  if (!flagPromise) {
    flagPromise = Promise.resolve()
      .then(() => window.clubhouse.app.getExperimentalSettings())
      .then((s) => s?.managedAgents === true)
      .catch(() => false)
      .then((v) => { flagValue = v; return v; });
  }
  return flagPromise;
}

/** Tests and the Experimental page. */
export function resetManagedFlag(): void {
  flagPromise = null;
  flagValue = null;
}

/** The flag, false until loaded. */
export function useManagedFlag(): boolean {
  const [on, setOn] = useState<boolean>(() => flagValue ?? false);
  useEffect(() => {
    let cancelled = false;
    void loadManagedFlag().then((v) => { if (!cancelled) setOn(v); });
    return () => { cancelled = true; };
  }, []);
  return on;
}
