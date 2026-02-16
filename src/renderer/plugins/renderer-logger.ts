import type { LogLevel } from '../../shared/types';

export function rendererLog(
  ns: string,
  level: LogLevel,
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown> },
): void {
  window.clubhouse.log.write({
    ts: new Date().toISOString(),
    ns,
    level,
    msg,
    projectId: opts?.projectId,
    meta: opts?.meta,
  });
}
