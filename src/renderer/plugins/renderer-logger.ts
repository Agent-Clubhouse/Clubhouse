import type { LogLevel } from '../../shared/types';
import { diag } from '../telemetry';

/**
 * Renderer logging (#2302): each line goes to the local-only diag tier (spec
 * §6.12), batched over `telemetry:emit`; main filters, redacts and
 * rate-limits it and never exports it. Feedback breadcrumbs don't come from
 * log lines: their producers record them directly (#2303).
 *
 * Never throws.
 */
export function rendererLog(
  ns: string,
  level: LogLevel,
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown> },
): void {
  // Diag lines have no projectId field; it travels in meta (a caller's own meta.projectId wins).
  const meta = opts?.projectId === undefined ? opts?.meta : { projectId: opts.projectId, ...opts.meta };
  diag(ns, level, msg, meta);
}
