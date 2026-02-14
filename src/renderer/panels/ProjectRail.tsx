import { useState, useRef, useCallback, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { Project } from '../../shared/types';
import { AGENT_COLORS } from '../../shared/name-generator';

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

  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 pr-[10px] ${
        expanded ? 'hover:bg-surface-0' : ''
      }`}
    >
      <div
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden text-sm font-bold
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
      <span className="text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text">
        {label}
      </span>
    </button>
  );
}

export function ProjectRail() {
  const { projects, activeProjectId, setActiveProject, pickAndAddProject, reorderProjects } =
    useProjectStore();
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const previousExplorerTab = useUIStore((s) => s.previousExplorerTab);

  const inSettings = explorerTab === 'settings';
  const isHome = activeProjectId === null && !inSettings;

  const [expanded, setExpanded] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setExpanded(true), 600);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setExpanded(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const exitSettingsAndNavigate = useCallback((action: () => void) => {
    if (inSettings) {
      setExplorerTab(previousExplorerTab || 'agents');
      useUIStore.setState({ previousExplorerTab: null });
    }
    action();
  }, [inSettings, previousExplorerTab, setExplorerTab]);

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

  return (
    <div
      className="relative h-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={`
          flex flex-col py-3 gap-2 bg-ctp-mantle border-r border-surface-0 h-full
          transition-[width] duration-200 ease-in-out overflow-hidden pl-[10px]
          ${expanded ? 'absolute inset-y-0 left-0 z-30 shadow-xl shadow-black/20' : ''}
        `}
        style={{ width: expanded ? 200 : 60 }}
      >
        {/* Home button */}
        <button
          onClick={() => exitSettingsAndNavigate(() => setActiveProject(null))}
          title="Home"
          className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 pr-[10px] ${
            expanded ? 'hover:bg-surface-0' : ''
          }`}
        >
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
              transition-colors duration-100
              ${isHome
                ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
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
          <span className="text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text">Home</span>
        </button>

        <div className="mr-[10px] border-t border-surface-2 my-1 flex-shrink-0" />

        {projects.map((p, i) => (
          <div
            key={p.id}
            ref={dragIndex === i ? dragNodeRef : undefined}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
            className="relative flex-shrink-0"
          >
            {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
              <div className="absolute -top-1.5 left-1 right-1 h-0.5 bg-indigo-500 rounded-full" />
            )}
            <ProjectIcon
              project={p}
              isActive={!inSettings && p.id === activeProjectId}
              onClick={() => exitSettingsAndNavigate(() => setActiveProject(p.id))}
              expanded={expanded}
            />
          </div>
        ))}
        <button
          onClick={() => pickAndAddProject()}
          title="Add project"
          className="
            w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0
            text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1
            cursor-pointer border border-dashed border-surface-2
          "
        >
          +
        </button>
        <div className="flex-1" />
        <div className="mr-[10px] border-t border-surface-2 my-1 flex-shrink-0" />
        <button
          onClick={toggleSettings}
          title="Settings"
          className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 pr-[10px] ${
            expanded ? 'hover:bg-surface-0' : ''
          }`}
        >
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
              transition-colors duration-100
              ${inSettings
                ? 'bg-surface-2 text-ctp-text'
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
          <span className="text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text">Settings</span>
        </button>
      </div>
    </div>
  );
}
