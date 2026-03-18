import { useState, useEffect, useCallback, useMemo } from 'react';

export interface PopoutEntry {
  windowId: number;
  params: {
    type: 'agent' | 'hub' | 'canvas';
    agentId?: string;
    hubId?: string;
    canvasId?: string;
    projectId?: string;
  };
}

/**
 * Reactively tracks which views are currently popped out.
 * Fetches the list on mount and refreshes whenever POPOUTS_CHANGED fires.
 */
export function usePopouts() {
  const [popouts, setPopouts] = useState<PopoutEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await window.clubhouse.window.listPopouts();
      setPopouts(list);
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

  const findHubPopout = useCallback(
    (hubId: string): PopoutEntry | undefined =>
      popouts.find((p) => p.params.type === 'hub' && p.params.hubId === hubId),
    [popouts],
  );

  const findCanvasPopout = useCallback(
    (canvasId: string): PopoutEntry | undefined =>
      popouts.find((p) => p.params.type === 'canvas' && p.params.canvasId === canvasId),
    [popouts],
  );

  return useMemo(() => ({
    popouts,
    findAgentPopout,
    findHubPopout,
    findCanvasPopout,
  }), [popouts, findAgentPopout, findHubPopout, findCanvasPopout]);
}
