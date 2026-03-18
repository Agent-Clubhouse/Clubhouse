/**
 * Satellite section for the Project Rail (#869).
 *
 * Renders a collapsible section for each paired satellite with its
 * remote projects listed underneath. Connected satellites appear first.
 */
import { useState, useCallback } from 'react';
import { AGENT_COLORS } from '../../shared/name-generator';
import type { SatelliteConnection } from '../stores/annexClientStore';
import type { RemoteProject } from '../stores/remoteProjectStore';

interface Props {
  satellite: SatelliteConnection;
  projects: RemoteProject[];
  activeProjectId: string | null;
  expanded: boolean;
  onSelectProject: (projectId: string) => void;
}

function getColorHex(colorId: string): string {
  const color = AGENT_COLORS.find((c) => c.id === colorId);
  return color?.hex || '#6366f1';
}

function SatelliteDivider({ satellite, collapsed, onToggle, expanded, onRetry }: {
  satellite: SatelliteConnection;
  collapsed: boolean;
  onToggle: () => void;
  expanded: boolean;
  onRetry: () => void;
}) {
  const colorHex = getColorHex(satellite.color);
  const isOnline = satellite.state === 'connected';

  return (
    <div
      className="flex items-center gap-2 py-1.5 cursor-pointer group"
      onClick={onToggle}
    >
      {/* Color accent bar */}
      <div className="w-0.5 h-4 rounded-full" style={{ backgroundColor: colorHex }} />

      {/* Status dot */}
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        isOnline ? 'bg-emerald-500' : 'bg-surface-2'
      }`} />

      {expanded && (
        <>
          <span className="text-xs font-medium text-ctp-subtext0 truncate flex-1">
            {satellite.alias}
          </span>

          {/* Collapse chevron */}
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-ctp-subtext0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>

          {/* Retry button for offline satellites */}
          {!isOnline && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              className="text-xs text-ctp-subtext0 hover:text-ctp-text opacity-0 group-hover:opacity-100 transition-opacity"
              title="Retry connection"
            >
              retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function SatelliteSection({ satellite, projects, activeProjectId, expanded, onSelectProject }: Props) {
  const storageKey = `satellite-collapsed-${satellite.id}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
  });

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [storageKey]);

  const handleRetry = useCallback(() => {
    window.clubhouse.annexClient?.retry(satellite.fingerprint);
  }, [satellite.fingerprint]);

  return (
    <div>
      <SatelliteDivider
        satellite={satellite}
        collapsed={collapsed}
        onToggle={toggleCollapse}
        expanded={expanded}
        onRetry={handleRetry}
      />

      {!collapsed && projects.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelectProject(p.id)}
          title={p.name}
          className={`
            w-full flex items-center gap-2 py-1 pl-4 rounded-md cursor-pointer
            ${activeProjectId === p.id
              ? 'bg-surface-1'
              : 'hover:bg-surface-0'
            }
          `}
        >
          <div
            className="w-6 h-6 rounded flex items-center justify-center text-white text-[10px] font-bold shrink-0"
            style={{ backgroundColor: getColorHex(satellite.color) + '80' }}
          >
            {p.name.slice(0, 2).toUpperCase()}
          </div>
          {expanded && (
            <span className={`text-xs truncate ${
              activeProjectId === p.id ? 'text-ctp-text' : 'text-ctp-subtext0'
            }`}>
              {p.displayName || p.name}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
