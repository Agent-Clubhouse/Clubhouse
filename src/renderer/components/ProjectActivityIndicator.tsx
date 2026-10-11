import type { ProjectActivitySummary } from '../utils/projectActivity';

/**
 * Status dot in a rail project icon's bottom-left corner. Green = running
 * agent(s), pulsing while one is working; amber with "!" when an agent is
 * waiting on permission.
 *
 * Geometry: the notification Badge owns the top-right corner, and rail icons
 * sit only 8px apart, so a bottom-right dot would collide with the next
 * project's badge. Bottom-left keeps the two on opposite sides. The fixed
 * 12px box at -5px/-5px centers the dot 1px inside the corner — mirroring the
 * Badge (10px at -top-1 -right-1) — and every state is centered in that box,
 * so switching states never shifts the dot.
 *
 * Decorative: the owning button carries the same information in its
 * title/aria-label via describeProjectActivity().
 */
export function ProjectActivityIndicator({ summary }: { summary: ProjectActivitySummary | undefined }) {
  if (!summary) return null;
  const { level } = summary;

  return (
    <span
      aria-hidden="true"
      data-testid="project-activity-indicator"
      data-level={level}
      className="absolute -bottom-[5px] -left-[5px] z-10 w-3 h-3 flex items-center justify-center pointer-events-none"
    >
      {level === 'needs_permission' ? (
        <span className="w-3 h-3 rounded-full ring-2 ring-ctp-mantle bg-ctp-warning text-ctp-mantle text-[8px] leading-none font-bold flex items-center justify-center">
          !
        </span>
      ) : (
        // Ring stays static; only the fill pulses, so the separator never fades.
        <span className="w-2.5 h-2.5 rounded-full ring-2 ring-ctp-mantle">
          <span
            className={`block w-full h-full rounded-full bg-ctp-success ${level === 'working' ? 'motion-safe:animate-pulse' : ''}`}
          />
        </span>
      )}
    </span>
  );
}
