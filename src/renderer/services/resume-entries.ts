import type { RestartSessionEntry } from '../../shared/types';

/**
 * The entries of this update's resume, kept so the banner's Resume and Retry
 * buttons can run the resume for one session. The main process hands the state
 * over once (read-once), so this is the only copy after startup. An entry goes
 * when its session resumes or the banner is dismissed. Kept apart from
 * resume-queue so the agent store can clear it without importing the queue.
 */
const entries = new Map<string, RestartSessionEntry>();

export function setResumeEntries(sessions: RestartSessionEntry[]): void {
  entries.clear();
  for (const entry of sessions) entries.set(entry.agentId, entry);
}

export function getResumeEntry(agentId: string): RestartSessionEntry | undefined {
  return entries.get(agentId);
}

export function deleteResumeEntry(agentId: string): void {
  entries.delete(agentId);
}

export function clearResumeEntries(): void {
  entries.clear();
}
