import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PopoutEntry } from '../../shared/plugin-types';

export type { PopoutEntry };

/**
 * Reactively tracks which views are currently popped out.
 * Fetches the list on mount and refreshes whenever POPOUTS_CHANGED fires.
 */
export function usePopouts() {
  const [popouts, setPopouts] = useState<PopoutEntry[]>([]);
  const [popoutsLoaded, setPopoutsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await window.clubhouse.window.listPopouts();
      setPopouts(list);
      setPopoutsLoaded(true);
    } catch {
      // Main process not ready yet — ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    const dispose = window.clubhouse.window.onPopoutsChanged(() => {
      refresh();
    });
    return dispose;
  }, [refresh]);

  const findAgentPopout = useCallback(
    (agentId: string): PopoutEntry | undefined =>
      popouts.find((p) => p.params.type === 'agent' && p.params.agentId === agentId),
    [popouts],
  );

  const findCanvasPopout = useCallback(
    (canvasId: string, context?: { projectId?: string }): PopoutEntry | undefined =>
      popouts.find((p) => p.params.type === 'canvas' && p.params.canvasId === canvasId
        && (!context || p.params.projectId === context.projectId)),
    [popouts],
  );

  return useMemo(() => ({
    popouts,
    popoutsLoaded,
    findAgentPopout,
    findCanvasPopout,
  }), [popouts, popoutsLoaded, findAgentPopout, findCanvasPopout]);
}
