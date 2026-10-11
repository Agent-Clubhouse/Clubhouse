/**
 * Shown in the rail when "Active only" filters out every project. The whole
 * row is one button that restores the full list, so it works the same in the
 * collapsed rail (icon + tooltip) and the expanded rail (icon + text).
 */
export function ProjectRailEmptyState({ expanded, onShowAll }: {
  expanded: boolean;
  onShowAll: () => void;
}) {
  return (
    <button
      onClick={onShowAll}
      title="No active projects — show all projects"
      data-testid="project-rail-empty-active"
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
        expanded ? 'hover:bg-surface-0' : ''
      }`}
    >
      <span
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 border border-dashed border-surface-2 text-ctp-overlay0 ${
          expanded ? '' : 'hover:bg-surface-1 hover:text-ctp-text'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </span>
      <span className={`flex flex-col items-start min-w-0 pr-3 whitespace-nowrap transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
        <span className="text-xs text-ctp-subtext0 truncate">No active projects</span>
        <span className="text-[11px] text-ctp-accent truncate">Show all projects</span>
      </span>
    </button>
  );
}
