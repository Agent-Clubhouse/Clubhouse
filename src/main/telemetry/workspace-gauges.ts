/**
 * Workspace gauges (spec §4.7, §4.9): the project count and active file
 * watches, sampled once a minute while telemetry is on. Nothing runs while
 * it is off. Follows the same start/stop pattern as health.ts.
 */
import { isTelemetryActive, onRuntimeChange, tel } from './facade';

export const WORKSPACE_SAMPLE_INTERVAL_MS = 60_000;

export interface WorkspaceGaugeSources {
  projectCount: () => Promise<number>;
  activeWatchCount: () => number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let installed = false;

/** One sampling pass. Exported for tests. */
export async function sampleWorkspace(sources: WorkspaceGaugeSources): Promise<void> {
  try {
    tel.count('clubhouse.file_watch.active', sources.activeWatchCount());
  } catch {
    // A failed source skips its gauge for this minute.
  }
  try {
    tel.count('clubhouse.projects.count', await sources.projectCount());
  } catch {
    // Project store unreadable: persist telemetry reports that separately.
  }
}

export function installWorkspaceTelemetry(sources: WorkspaceGaugeSources): void {
  if (installed) return;
  installed = true;
  const sync = (): void => {
    if (isTelemetryActive() && !timer) {
      void sampleWorkspace(sources);
      timer = setInterval(() => void sampleWorkspace(sources), WORKSPACE_SAMPLE_INTERVAL_MS);
      timer.unref?.();
    } else if (!isTelemetryActive() && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  onRuntimeChange(sync);
  sync();
}

export function _resetWorkspaceTelemetryForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  installed = false;
}
