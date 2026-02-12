import { useState, useRef, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { Project } from '../../shared/types';
import { AGENT_COLORS } from '../../shared/name-generator';

function getColorHex(colorId?: string): string {
  if (!colorId) return '#6366f1'; // indigo default
  return AGENT_COLORS.find((c) => c.id === colorId)?.hex || '#6366f1';
}

function ProjectIcon({ project, isActive, onClick }: {
  project: Project;
  isActive: boolean;
  onClick: () => void;
}) {
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const iconDataUrl = projectIcons[project.id];
  const hex = getColorHex(project.color);
  const letter = project.name.charAt(0).toUpperCase();

  const hasImage = !!project.icon && !!iconDataUrl;

  return (
    <button
      onClick={onClick}
      title={project.name}
      className={`
        w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold
        transition-all duration-150 cursor-pointer overflow-hidden
        ${isActive
          ? 'text-white shadow-lg'
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
          alt={project.name}
          className={`w-full h-full object-cover ${isActive ? 'ring-2 ring-white/30 rounded-lg' : ''}`}
        />
      ) : (
        letter
      )}
    </button>
  );
}

export function ProjectRail() {
  const { projects, activeProjectId, setActiveProject, pickAndAddProject, reorderProjects } =
    useProjectStore();

  const isHome = activeProjectId === null;

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Make the drag image slightly transparent
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
    <div className="flex flex-col items-center py-3 gap-2 bg-ctp-mantle border-r border-surface-0 h-full">
      {/* Home button */}
      <button
        onClick={() => setActiveProject(null)}
        title="Home"
        className={`
          w-10 h-10 rounded-lg flex items-center justify-center
          transition-all duration-150 cursor-pointer
          ${isHome
            ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
            : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text'
          }
        `}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>

      <div className="w-6 border-t border-surface-2 my-1" />

      {projects.map((p, i) => (
        <div
          key={p.id}
          ref={dragIndex === i ? dragNodeRef : undefined}
          draggable
          onDragStart={(e) => handleDragStart(e, i)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, i)}
          onDrop={(e) => handleDrop(e, i)}
          className="relative"
        >
          {/* Drop indicator line */}
          {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
            <div className="absolute -top-1.5 left-1 right-1 h-0.5 bg-indigo-500 rounded-full" />
          )}
          <ProjectIcon
            project={p}
            isActive={p.id === activeProjectId}
            onClick={() => setActiveProject(p.id)}
          />
        </div>
      ))}
      <button
        onClick={() => pickAndAddProject()}
        title="Add project"
        className="w-10 h-10 rounded-lg flex items-center justify-center text-lg
          text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1
          transition-all duration-150 cursor-pointer border border-dashed border-surface-2"
      >
        +
      </button>
    </div>
  );
}
