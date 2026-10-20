import type { LogLevel } from '../../shared/types';
import { diag } from '../telemetry';

/**
 * Renderer logging (#2302). Each line goes two ways:
 * - to the local-only diag tier (spec §6.12), batched over `telemetry:emit`;
 *   main filters, redacts and rate-limits it and never exports it;
 * - over the deprecated `log:write` IPC to the legacy session log and the
 *   feedback breadcrumb tap, until the writer is deleted (#2313, #2303).
 *
 * Never throws.
 */
export function rendererLog(
  ns: string,
  level: LogLevel,
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown> },
): void {
  // Diag lines have no projectId field; it travels in meta.
  const meta = opts?.projectId === undefined ? opts?.meta : { ...opts.meta, projectId: opts.projectId };
  diag(ns, level, msg, meta);
  try {
    window.clubhouse?.log?.write({
      ts: new Date().toISOString(),
      ns,
      level,
      msg,
      projectId: opts?.projectId,
      meta: opts?.meta,
    });
  } catch {
    // telemetry-exempt: the legacy writer is best effort; the line already went to diag
  }
}
