/**
 * The Dispatcher work view's reading of its conversation (#3242): which CLI
 * run is active, if any, and whether that run is failing. Errors kept from an
 * ended run, or from before a fresh start, are history: they never make the
 * work look unhealthy.
 */
import type { ChatViewState, NoticeItem } from '../../stores/chatStore';

/** When the active run started, or null when no run is active (asleep, ended, or never started). */
export function activeRunSince(state: ChatViewState | undefined): number | null {
  // A failed turn also reads 'error', with the run still going: its end is what ends it.
  if (!state || state.state === null || state.state === 'sleeping') return null;
  const last = state.runs[state.runs.length - 1];
  return last && last.endedAt === null ? last.startedAt : null;
}

/** The active run's last turn failed. False with no active run. */
export function activeRunFailing(state: ChatViewState | undefined): boolean {
  const since = activeRunSince(state);
  if (!state || since === null) return false;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.ts < since) return false;
    if (item.kind === 'turn_end') return item.stopReason === 'error';
  }
  return false;
}

/** The "started fresh" notice this conversation opened with (#3240), if it did. */
export function startedFreshNotice(state: ChatViewState | undefined): NoticeItem | null {
  const item = state?.items.find((i): i is NoticeItem => i.kind === 'notice' && i.code === 'started_fresh');
  return item ?? null;
}
