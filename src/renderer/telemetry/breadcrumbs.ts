/**
 * Feedback breadcrumbs from the renderer (#2098, #2303): view changes,
 * runtime switches and long-frame bursts. Sent to main on their own channel,
 * so they don't depend on the log or telemetry settings, or on the legacy
 * log path existing. Main checks each code; plugins have no way to add one.
 */
import type { RendererBreadcrumb } from '../../shared/feedback-types';

export function recordBreadcrumb(kind: RendererBreadcrumb['kind'], code: string, value?: number): void {
  try {
    window.clubhouse?.feedback?.recordBreadcrumb?.(value === undefined ? { kind, code } : { kind, code, value });
  } catch {
    // telemetry-exempt: no preload bridge (tests, early startup); a breadcrumb is optional.
  }
}
