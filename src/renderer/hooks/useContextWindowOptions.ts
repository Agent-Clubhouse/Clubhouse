import { useEffect, useState } from 'react';
import type { ContextWindowOptions } from '../../shared/context-window';

/**
 * The context choices for an agent's CLI and model (#2660). Asks main only
 * while `enabled`, so a closed card or an awake agent reads nothing; main caches
 * any catalog that needs a process. Null while loading.
 */
export function useContextWindowOptions(enabled: boolean, projectPath: string | undefined, orchestrator: string | undefined, model: string | undefined): ContextWindowOptions | null {
  const key = enabled && projectPath ? `${projectPath}\n${orchestrator ?? ''}\n${model ?? ''}` : null;
  const [loaded, setLoaded] = useState<{ key: string; options: ContextWindowOptions } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    window.clubhouse.agent.getContextWindowOptions(projectPath!, orchestrator, model).then(
      (options) => { if (alive) setLoaded({ key, options }); },
      // telemetry-exempt: the row shows it unavailable.
      () => { if (alive) setLoaded({ key, options: { configurable: false, state: 'unavailable', label: 'Context', reason: 'Couldn’t read this CLI’s context settings.' } }); },
    );
    return () => { alive = false; };
  }, [key]);
  return key && loaded?.key === key ? loaded.options : null;
}
