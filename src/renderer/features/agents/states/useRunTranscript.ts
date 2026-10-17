import { useEffect, useRef, useState } from 'react';
import type { AgentHookEvent } from '../../../../shared/types';
import { TimelineBuilder, type RunTotals, type Step, type TranscriptEventLike } from './timeline';

const PAGE_SIZE = 100;
/** How recently a hook must have fired for us to consider hooks "active" and skip polling. */
const HOOK_ACTIVE_THRESHOLD_MS = 5_000;
/** Fallback poll interval, used only when hooks are not firing. */
const FALLBACK_POLL_INTERVAL_MS = 5_000;
/** Keep at most this many notification lines (stderr) in the timeline. */
const MAX_NOTES = 50;

export interface RunTranscript {
  steps: Step[];
  totals: RunTotals;
  /** Bumps on every post-tool and stop hook, for refreshing diff stats. */
  toolTick: number;
}

/**
 * Reads a headless run's transcript page by page into timeline steps.
 * While `live`, hook events trigger immediate syncs and a slow fallback poll
 * catches anything they miss; stderr notifications become text steps. When not
 * live it loads the whole transcript once (from disk after exit).
 */
export function useRunTranscript(agentId: string, live: boolean): RunTranscript {
  const [state, setState] = useState<RunTranscript>(() => ({ steps: [], totals: emptyTotals(), toolTick: 0 }));
  const builderRef = useRef<TimelineBuilder>(new TimelineBuilder());
  const notesRef = useRef<Step[]>([]);
  const offsetRef = useRef(0);
  const tickRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let syncing = false;
    let again = false;
    let lastHookAt = 0;
    builderRef.current = new TimelineBuilder();
    notesRef.current = [];
    offsetRef.current = 0;
    tickRef.current = 0;
    setState({ steps: [], totals: emptyTotals(), toolTick: 0 });

    // Batch state updates to one per animation frame
    const publish = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (cancelled) return;
        const b = builderRef.current;
        const steps = notesRef.current.length
          ? [...b.steps, ...notesRef.current].sort((a, c) => a.ts - c.ts)
          : [...b.steps];
        setState({ steps, totals: { ...b.totals }, toolTick: tickRef.current });
      });
    };

    async function sync(): Promise<void> {
      if (cancelled) return;
      if (syncing) { again = true; return; }
      syncing = true;
      try {
        while (!cancelled) {
          again = false;
          const page = await window.clubhouse.agent.readTranscriptPage(agentId, offsetRef.current, PAGE_SIZE);
          if (cancelled || !page) return;
          if (page.events.length === 0) {
            if (page.totalEvents > offsetRef.current) offsetRef.current = page.totalEvents;
            return;
          }
          offsetRef.current += page.events.length;
          builderRef.current.push(page.events as TranscriptEventLike[]);
          publish();
          if (offsetRef.current >= page.totalEvents) return;
        }
      } catch {
        // telemetry-exempt: the transcript isn't written yet; the next hook or poll retries
      } finally {
        syncing = false;
        if (again && !cancelled) void sync();
      }
    }

    void sync();
    if (!live) {
      return () => { cancelled = true; if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = 0; };
    }

    const removeListener = window.clubhouse.agent.onHookEvent((id: string, event: AgentHookEvent) => {
      if (id !== agentId) return;
      lastHookAt = Date.now();
      if (event.kind === 'notification' && event.message) {
        notesRef.current.push({ kind: 'text', id: `note:${notesRef.current.length}:${event.timestamp}`, ts: event.timestamp || Date.now(), text: event.message });
        if (notesRef.current.length > MAX_NOTES) notesRef.current.shift();
        publish();
        return;
      }
      if (event.kind === 'post_tool' || event.kind === 'stop') tickRef.current += 1;
      if (event.kind === 'pre_tool' || event.kind === 'post_tool' || event.kind === 'stop') void sync();
    });

    const poll = setInterval(() => {
      if (Date.now() - lastHookAt < HOOK_ACTIVE_THRESHOLD_MS) return;
      void sync();
    }, FALLBACK_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      removeListener();
      clearInterval(poll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [agentId, live]);

  return state;
}

function emptyTotals(): RunTotals {
  return { toolCalls: 0, inputTokens: 0, outputTokens: 0, summary: null, resultIsError: false };
}

/** Re-render every second while `active`, for elapsed times. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
