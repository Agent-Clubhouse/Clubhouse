/**
 * Satellite host rows for the Project Rail.
 *
 * Renders satellites as single-row host buttons in the rail. When a satellite
 * is the active host, it expands to show its remote projects. Non-active
 * hosts render as compact single-row entries with a status dot.
 */
import { useCallback } from 'react';
import { AGENT_COLORS } from '../../shared/name-generator';
import type { SatelliteConnection } from '../stores/annexClientStore';
import { useRemoteProjectStore, type RemoteProject } from '../stores/remoteProjectStore';

function getColorHex(colorId: string): string {
  const color = AGENT_COLORS.find((c) => c.id === colorId);
  return color?.hex || '#6366f1';
}

// ---------------------------------------------------------------------------
// LocalHostRow — collapsed machine icon for the local host
// ---------------------------------------------------------------------------

export function LocalHostRow({ expanded, isActive, onClick }: {
  expanded: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title="Local"
      data-testid="host-local"
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
        expanded ? 'hover:bg-surface-0' : ''
      }`}
    >
      <div
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
          transition-colors duration-100
          ${isActive
            ? 'bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30'
            : expanded
              ? 'bg-surface-1 text-ctp-subtext0'
              : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
          }
        `}
      >
        {/* Monitor/desktop icon */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </div>
      <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
        Local
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SatelliteHostRow — compact single-row satellite entry with status dot
// ---------------------------------------------------------------------------

export function SatelliteHostRow({ satellite, expanded, isActive, onClick }: {
  satellite: SatelliteConnection;
  expanded: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  const colorHex = getColorHex(satellite.color);
  const isOnline = satellite.state === 'connected';

  const handleRetry = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    window.clubhouse.annexClient?.retry(satellite.fingerprint);
  }, [satellite.fingerprint]);

  return (
    <button
      onClick={onClick}
      title={satellite.alias}
      data-testid={`host-satellite-${satellite.id}`}
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 group ${
        expanded ? 'hover:bg-surface-0' : ''
      }`}
    >
      <div
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 relative
          transition-colors duration-100
          ${isActive
            ? 'text-white shadow-lg'
            : expanded
              ? 'bg-surface-1 text-ctp-subtext0'
              : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
          }
        `}
        style={isActive ? {
          backgroundColor: colorHex,
          boxShadow: `0 10px 15px -3px ${colorHex}30, 0 4px 6px -4px ${colorHex}30`,
        } : undefined}
      >
        {/* Satellite/server icon */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" />
          <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
        {/* Status dot — overlaid bottom-right */}
        <div
          data-testid={`host-status-${satellite.id}`}
          className={`absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full border border-ctp-mantle ${
            isOnline ? 'bg-emerald-500' : 'bg-surface-2'
          }`}
        />
      </div>
      {expanded && (
        <>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {/* Color accent bar */}
            <div className="w-0.5 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: colorHex }} />
            <span className={`text-xs font-medium truncate text-ctp-text transition-opacity duration-200`}>
              {satellite.alias}
            </span>
          </div>
          {/* Retry button for offline satellites */}
          {!isOnline && (
            <span
              role="button"
              onClick={handleRetry}
              className="text-[10px] text-ctp-subtext0 hover:text-ctp-text opacity-0 group-hover:opacity-100 transition-opacity pr-2 cursor-pointer"
              title="Retry connection"
            >
              retry
            </span>
          )}
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// SatelliteProjectList — remote projects for an active satellite host
// ---------------------------------------------------------------------------

export function SatelliteProjectList({ satellite, projects, activeProjectId, expanded, onSelectProject }: {
  satellite: SatelliteConnection;
  projects: RemoteProject[];
  activeProjectId: string | null;
  expanded: boolean;
  onSelectProject: (projectId: string) => void;
}) {
  const remoteProjectIcons = useRemoteProjectStore((s) => s.remoteProjectIcons);
  const colorHex = getColorHex(satellite.color);

  if (projects.length === 0) {
    return expanded ? (
      <div className="pl-4 py-2 text-xs text-ctp-subtext0 italic">No projects</div>
    ) : null;
  }

  return (
    <>
      {projects.map((p) => {
        const iconDataUrl = remoteProjectIcons[p.id];
        const label = p.displayName || p.name;
        const letter = label.charAt(0).toUpperCase();
        const isActive = activeProjectId === p.id;

        return (
          <button
            key={p.id}
            onClick={() => onSelectProject(p.id)}
            title={label}
            data-testid={`project-${p.id}`}
            data-active={isActive}
            className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
              expanded ? 'hover:bg-surface-0' : ''
            }`}
          >
            <div className="relative w-10 h-10 flex-shrink-0">
              <div
                className={`
                  w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden text-sm font-bold
                  transition-colors duration-100
                  ${isActive
                    ? 'text-white shadow-lg'
                    : expanded
                      ? 'bg-surface-1 text-ctp-subtext0'
                      : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
                  }
                `}
                style={isActive ? {
                  backgroundColor: iconDataUrl ? undefined : colorHex,
                  boxShadow: `0 10px 15px -3px ${colorHex}30, 0 4px 6px -4px ${colorHex}30`,
                } : undefined}
              >
                {iconDataUrl ? (
                  <img
                    src={iconDataUrl}
                    alt={label}
                    className={`w-full h-full object-cover ${isActive ? 'ring-2 ring-white/30 rounded-lg' : ''}`}
                  />
                ) : (
                  letter
                )}
              </div>
            </div>
            <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
              {label}
            </span>
          </button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// SatelliteSections — exported container used by ProjectRail (default/local view)
// ---------------------------------------------------------------------------

/** Renders satellite host rows (connected first, then offline, both alphabetical). */
export function SatelliteSections({ satellites, expanded, activeHostId, onActivateHost }: {
  satellites: SatelliteConnection[];
  expanded: boolean;
  activeHostId: string | null;
  onActivateHost: (satelliteId: string) => void;
}) {
  if (satellites.length === 0) return null;

  // Sort: connected first, then alphabetical
  const sorted = [...satellites].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <>
      {sorted.map((sat) => (
        <div key={sat.id}>
          <div className="border-t border-surface-2 my-1 flex-shrink-0" />
          <SatelliteHostRow
            satellite={sat}
            expanded={expanded}
            isActive={activeHostId === sat.id}
            onClick={() => onActivateHost(sat.id)}
          />
        </div>
      ))}
    </>
  );
}
