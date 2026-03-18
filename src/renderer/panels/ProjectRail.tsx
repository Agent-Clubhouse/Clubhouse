import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { SatelliteSection } from './SatelliteSection';
import { useBadgeStore, aggregateBadges } from '../stores/badgeStore';
import { useBadgeSettingsStore } from '../stores/badgeSettingsStore';
import { usePanelStore } from '../stores/panelStore';
import { Badge } from '../components/Badge';
import { Project } from '../../shared/types';
import { PluginRegistryEntry } from '../../shared/plugin-types';
import { AGENT_COLORS } from '../../shared/name-generator';

/** Renders satellite sections (connected first, then offline, both alphabetical). */
function SatelliteSections({ activeProjectId, expanded, onSelectProject }: {
  activeProjectId: string | null;
  expanded: boolean;
  onSelectProject: (id: string) => void;
}) {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);

  if (satellites.length === 0) return null;

  // Sort: connected first, then alphabetical
  const sorted = [...satellites].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <>
      <div className="border-t border-surface-2 my-1 flex-shrink-0" />
      {sorted.map((sat) => (
        <SatelliteSection
          key={sat.id}
          satellite={sat}
          projects={satelliteProjects[sat.fingerprint] || []}
          activeProjectId={activeProjectId}
          expanded={expanded}
          onSelectProject={onSelectProject}
        />
      ))}
    </>
  );
}

function ProjectContextMenu({ position, onClose, onSettings, onCloseProject }: {
  position: { x: number; y: number };
  onClose: () => void;
  onSettings: () => void;
  onCloseProject: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const style = useMemo(() => {
    const menuWidth = 180;
    const menuHeight = 2 * 32 + 8;
    const x = Math.min(position.x, window.innerWidth - menuWidth - 8);
    const y = Math.min(position.y, window.innerHeight - menuHeight - 8);
    return { left: x, top: y };
  }, [position]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle"
      style={style}
      data-testid="project-context-menu"
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors cursor-pointer"
        onClick={(e) => { e.stopPropagation(); onSettings(); onClose(); }}
        data-testid="ctx-project-settings"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>Project Settings</span>
      </button>
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-1 hover:text-red-300 transition-colors cursor-pointer"
        onClick={(e) => { e.stopPropagation(); onCloseProject(); onClose(); }}
        data-testid="ctx-close-project"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        <span>Close Project</span>
      </button>
    </div>
  );
}

function getColorHex(colorId?: string): string {
  if (!colorId) return '#6366f1'; // indigo default
  return AGENT_COLORS.find((c) => c.id === colorId)?.hex || '#6366f1';
}

function ProjectIcon({ project, isActive, onClick, expanded }: {
  project: Project;
  isActive: boolean;
  onClick: () => void;
  expanded: boolean;
}) {
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const iconDataUrl = projectIcons[project.id];
  const hex = getColorHex(project.color);
  const label = project.displayName || project.name;
  const letter = label.charAt(0).toUpperCase();
  const hasImage = !!project.icon && !!iconDataUrl;
  const badges = useBadgeStore((s) => s.badges);
  const bsEnabled = useBadgeSettingsStore((s) => s.enabled);
  const bsPluginBadges = useBadgeSettingsStore((s) => s.pluginBadges);
  const bsProjectRailBadges = useBadgeSettingsStore((s) => s.projectRailBadges);
  const bsProjectOverride = useBadgeSettingsStore((s) => s.projectOverrides[project.id]);
  const projectBadge = useMemo(() => {
    const enabled = bsProjectOverride?.enabled ?? bsEnabled;
    const projectRailBadges = bsProjectOverride?.projectRailBadges ?? bsProjectRailBadges;
    if (!enabled || !projectRailBadges) return null;
    let filtered = Object.values(badges).filter(
      (b) => b.target.kind === 'explorer-tab' && b.target.projectId === project.id,
    );
    const pluginBadges = bsProjectOverride?.pluginBadges ?? bsPluginBadges;
    if (!pluginBadges) {
      filtered = filtered.filter((b) => !b.source.startsWith('plugin:'));
    }
    return aggregateBadges(filtered);
  }, [badges, project.id, bsEnabled, bsPluginBadges, bsProjectRailBadges, bsProjectOverride]);

  return (
    <button
      onClick={onClick}
      title={label}
      data-testid={`project-${project.id}`}
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
            backgroundColor: hasImage ? undefined : hex,
            boxShadow: `0 10px 15px -3px ${hex}30, 0 4px 6px -4px ${hex}30`,
          } : undefined}
        >
          {hasImage ? (
            <img
              src={iconDataUrl}
              alt={label}
              className={`w-full h-full object-cover ${isActive ? 'ring-2 ring-white/30 rounded-lg' : ''}`}
            />
          ) : (
            letter
          )}
        </div>
        {projectBadge && (
          <span className="absolute -top-1 -right-1 z-10">
            <Badge type={projectBadge.type} value={projectBadge.value} />
          </span>
        )}
      </div>
      <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
        {label}
      </span>
    </button>
  );
}

function PluginRailButton({ entry, isActive, onClick, expanded }: {
  entry: PluginRegistryEntry;
  isActive: boolean;
  onClick: () => void;
  expanded: boolean;
}) {
  const label = entry.manifest.contributes!.railItem!.label;
  const customIcon = entry.manifest.contributes!.railItem!.icon;
  const pluginBadges = useBadgeStore((s) => s.badges);
  const bsEnabled = useBadgeSettingsStore((s) => s.enabled);
  const bsPluginBadges = useBadgeSettingsStore((s) => s.pluginBadges);
  const pluginBadge = useMemo(() => {
    if (!bsEnabled || !bsPluginBadges) return null;
    const filtered = Object.values(pluginBadges).filter(
      (b) => b.target.kind === 'app-plugin' && b.target.pluginId === entry.manifest.id,
    );
    return aggregateBadges(filtered);
  }, [pluginBadges, entry.manifest.id, bsEnabled, bsPluginBadges]);

  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
        expanded ? 'hover:bg-surface-0' : ''
      }`}
    >
      <div className="relative w-10 h-10 flex-shrink-0">
        <div
          className={`
            w-10 h-10 rounded-lg flex items-center justify-center
            transition-colors duration-100
            ${isActive
              ? 'bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30'
              : expanded
                ? 'bg-surface-1 text-ctp-subtext0'
                : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
            }
          `}
        >
          {customIcon ? (
            <span dangerouslySetInnerHTML={{ __html: customIcon }} />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          )}
        </div>
        {pluginBadge && (
          <span className="absolute -top-1 -right-1 z-10">
            <Badge type={pluginBadge.type} value={pluginBadge.value} />
          </span>
        )}
      </div>
      <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>{label}</span>
    </button>
  );
}

export function ProjectRail() {
  const { projects, activeProjectId, setActiveProject, pickAndAddProject, reorderProjects, removeProject } =
    useProjectStore();
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const toggleHelp = useUIStore((s) => s.toggleHelp);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const previousExplorerTab = useUIStore((s) => s.previousExplorerTab);
  const showHome = useUIStore((s) => s.showHome);

  const plugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const pluginSettings = usePluginStore((s) => s.pluginSettings);

  const inSettings = explorerTab === 'settings';
  const inHelp = explorerTab === 'help';
  const isAppPlugin = explorerTab.startsWith('plugin:app:');
  const isHome = activeProjectId === null && !inSettings && !inHelp && !isAppPlugin;

  // App-enabled is the source of truth for rail visibility.
  // Status is an internal runtime detail — incompatible plugins are the only exclusion.
  const appPluginItems = appEnabled
    .map((id) => plugins[id])
    .filter((entry) => {
      if (!entry) return false;
      if (entry.manifest.scope !== 'app' && entry.manifest.scope !== 'dual') return false;
      if (entry.status === 'incompatible') return false;
      if (!entry.manifest.contributes?.railItem) return false;
      // For dual plugins, check cross-project-hub setting
      if (entry.manifest.scope === 'dual') {
        const settings = pluginSettings[`app:${entry.manifest.id}`];
        const crossProjectSetting = settings?.['cross-project-hub'];
        if (crossProjectSetting === false) return false;
      }
      return true;
    });

  const topPluginItems = appPluginItems.filter(
    (e) => (e.manifest.contributes!.railItem!.position ?? 'top') === 'top'
  );
  const bottomPluginItems = appPluginItems.filter(
    (e) => e.manifest.contributes!.railItem!.position === 'bottom'
  );

  const railPinned = usePanelStore((s) => s.railPinned);
  const railWidth = usePanelStore((s) => s.railWidth);
  const toggleRailPin = usePanelStore((s) => s.toggleRailPin);

  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [overlaying, setOverlaying] = useState(false);
  const [isScrollable, setIsScrollable] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // The rail is visually expanded when pinned OR hover-expanded
  const expanded = railPinned || hoverExpanded;

  const handleMouseEnter = useCallback(() => {
    if (railPinned) return;
    if (overlayTimerRef.current) {
      clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = null;
    }
    hoverTimerRef.current = setTimeout(() => {
      setHoverExpanded(true);
      setOverlaying(true);
    }, 600);
  }, [railPinned]);

  const handleMouseLeave = useCallback(() => {
    if (railPinned) return;
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverExpanded(false);
    // Keep overlay styling (absolute + z-30) during the 200ms close transition
    overlayTimerRef.current = setTimeout(() => setOverlaying(false), 200);
  }, [railPinned]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    };
  }, []);

  // Detect when the project list overflows and needs a scrollbar
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const check = () => setIsScrollable(el.scrollHeight > el.clientHeight);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [projects.length]);

  // Sync rail width to a CSS variable so the grid column in App.tsx can match
  const collapsedWidth = isScrollable ? 76 : 70;
  useEffect(() => {
    const width = railPinned ? railWidth : collapsedWidth;
    document.documentElement.style.setProperty('--rail-width', `${width}px`);
  }, [collapsedWidth, railPinned, railWidth]);

  const exitSettingsAndNavigate = useCallback((action: () => void) => {
    if (inSettings || inHelp) {
      setExplorerTab(previousExplorerTab || 'agents');
      useUIStore.setState({ previousExplorerTab: null });
    } else if (isAppPlugin) {
      setExplorerTab('agents');
    }
    action();
  }, [inSettings, inHelp, isAppPlugin, previousExplorerTab, setExplorerTab]);

  const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = [...projects];
    const [moved] = newOrder.splice(dragIndex, 1);
    newOrder.splice(dropIndex, 0, moved);
    reorderProjects(newOrder.map((p) => p.id));

    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, projects, reorderProjects]);

  const handlePinClick = useCallback(() => {
    toggleRailPin();
    // If we're pinning, clear hover state since pin takes over
    if (!railPinned) {
      setHoverExpanded(false);
      setOverlaying(false);
    }
  }, [toggleRailPin, railPinned]);

  const computedWidth = railPinned ? railWidth : (hoverExpanded ? 200 : collapsedWidth);

  return (
    <div
      className="relative h-full min-h-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-testid="rail-container"
    >
      <div
        className={`
          relative flex flex-col py-3 gap-2 bg-ctp-mantle border-r border-surface-0 h-full
          transition-[width] duration-200 ease-in-out overflow-hidden pl-[14px] pr-[10px]
          ${!railPinned && overlaying ? 'absolute inset-y-0 left-0 z-30 shadow-xl shadow-black/20' : ''}
        `}
        style={{ width: computedWidth }}
      >
        {/* Pin button — absolutely positioned top-right, aligned with first rail item */}
        <button
          onClick={handlePinClick}
          title={railPinned ? 'Unpin sidebar' : 'Pin sidebar open'}
          data-testid="rail-pin-button"
          className={`
            absolute top-[20px] right-[10px] z-10
            w-6 h-6 flex items-center justify-center rounded
            transition-opacity duration-200 cursor-pointer
            ${expanded ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            ${railPinned
              ? 'text-ctp-accent hover:bg-surface-1'
              : 'text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1'
            }
          `}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={railPinned ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={railPinned ? '' : 'rotate-45'}
          >
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
          </svg>
        </button>
        {/* Home button */}
        {showHome && (
          <button
            onClick={() => exitSettingsAndNavigate(() => setActiveProject(null))}
            title="Home"
            data-testid="nav-home"
            className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
              expanded ? 'hover:bg-surface-0' : ''
            }`}
          >
            <div
              className={`
                w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
                transition-colors duration-100
                ${isHome
                  ? 'bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30'
                  : expanded
                    ? 'bg-surface-1 text-ctp-subtext0'
                    : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
                }
              `}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
            <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>Home</span>
          </button>
        )}

        {/* Top app-scoped plugin items */}
        {topPluginItems.map((entry) => {
          const tabId = `plugin:app:${entry.manifest.id}`;
          return (
            <PluginRailButton
              key={tabId}
              entry={entry}
              isActive={explorerTab === tabId}
              onClick={() => exitSettingsAndNavigate(() => setExplorerTab(tabId))}
              expanded={expanded}
            />
          );
        })}

        {(showHome || topPluginItems.length > 0) && (
          <div className="border-t border-surface-2 my-1 flex-shrink-0" />
        )}

        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-2 pt-1">
          {projects.map((p, i) => (
            <div
              key={p.id}
              ref={dragIndex === i ? dragNodeRef : undefined}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ projectId: p.id, x: e.clientX, y: e.clientY });
              }}
              className="relative flex-shrink-0"
            >
              {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
                <div className="absolute -top-1.5 left-1 right-1 h-0.5 bg-indigo-500 rounded-full" />
              )}
              <ProjectIcon
                project={p}
                isActive={!inSettings && !inHelp && !isAppPlugin && p.id === activeProjectId}
                onClick={() => exitSettingsAndNavigate(() => setActiveProject(p.id))}
                expanded={expanded}
              />
            </div>
          ))}
          <button
            onClick={() => pickAndAddProject()}
            title="Add project"
            data-testid="nav-add-project"
            className="
              w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0
              text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1
              cursor-pointer border border-dashed border-surface-2
            "
          >
            +
          </button>

          {/* Satellite sections (Annex V2) */}
          <SatelliteSections
            activeProjectId={activeProjectId}
            expanded={expanded}
            onSelectProject={(id) => exitSettingsAndNavigate(() => setActiveProject(id))}
          />
        </div>
        {/* Bottom app-scoped plugin items */}
        {bottomPluginItems.map((entry) => {
          const tabId = `plugin:app:${entry.manifest.id}`;
          return (
            <PluginRailButton
              key={tabId}
              entry={entry}
              isActive={explorerTab === tabId}
              onClick={() => exitSettingsAndNavigate(() => setExplorerTab(tabId))}
              expanded={expanded}
            />
          );
        })}
        <div className="border-t border-surface-2 my-1 flex-shrink-0" />
        <button
          onClick={toggleHelp}
          title="Help"
          data-testid="nav-help"
          className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
            expanded ? 'hover:bg-surface-0' : ''
          }`}
        >
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
              transition-colors duration-100
              ${inHelp
                ? 'bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30'
                : expanded
                  ? 'text-ctp-subtext0'
                  : 'text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text'
              }
            `}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>Help</span>
        </button>
        <button
          onClick={toggleSettings}
          title="Settings"
          data-testid="nav-settings"
          className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
            expanded ? 'hover:bg-surface-0' : ''
          }`}
        >
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
              transition-colors duration-100
              ${inSettings
                ? 'bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30'
                : expanded
                  ? 'text-ctp-subtext0'
                  : 'text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text'
              }
            `}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>Settings</span>
        </button>
      </div>
      {contextMenu && (
        <ProjectContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onSettings={() => {
            setActiveProject(contextMenu.projectId);
            toggleSettings();
            setSettingsContext('project');
            setSettingsSubPage('project');
          }}
          onCloseProject={() => removeProject(contextMenu.projectId)}
        />
      )}
    </div>
  );
}
