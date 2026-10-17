import React, { useState, useRef, useCallback } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { Badge } from '../components/Badge';
import { getAgentColorHex } from '../../shared/name-generator';
import { useProjectTabs, useTabBadge, type TabEntry } from '../chrome/useProjectTabs';

function SettingsContextPicker() {
  const settingsContext = useUIStore((s) => s.settingsContext);
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);
  const projects = useProjectStore((s) => s.projects);
  const projectIcons = useProjectStore((s) => s.projectIcons);

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full min-h-0">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Settings</h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col min-h-0 overflow-y-auto">
        <button
          onClick={() => setSettingsContext('app')}
          className={`
            w-full px-3 py-3 text-left text-sm flex items-center gap-3
            transition-colors duration-100 cursor-pointer
            ${settingsContext === 'app'
              ? 'bg-surface-1 text-ctp-text'
              : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
            }
          `}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Clubhouse
        </button>

        {projects.length > 0 && (
          <div className="w-full border-t border-surface-0 my-1" />
        )}

        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setSettingsContext(p.id)}
            className={`
              w-full px-3 py-3 text-left text-sm flex items-center gap-3
              transition-colors duration-100 cursor-pointer truncate
              ${settingsContext === p.id
                ? 'bg-surface-1 text-ctp-text'
                : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }
            `}
          >
            <span
              className="w-[18px] h-[18px] rounded flex items-center justify-center text-xs font-bold flex-shrink-0 overflow-hidden"
              style={p.icon && projectIcons[p.id] ? undefined : { backgroundColor: `${getAgentColorHex(p.color)}20`, color: getAgentColorHex(p.color) }}
            >
              {p.icon && projectIcons[p.id] ? (
                <img src={projectIcons[p.id]} alt={(p.displayName || p.name)} className="w-full h-full object-cover" />
              ) : (
                (p.displayName || p.name).charAt(0).toUpperCase()
              )}
            </span>
            <span className="truncate">{p.displayName || p.name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

const TabButton = React.memo(function TabButton({ tab, isActive, projectId, onClick }: { tab: TabEntry; isActive: boolean; projectId: string | null; onClick: () => void }) {
  const isDisabled = tab.disabled === true;
  const tabBadge = useTabBadge(tab.id, projectId);

  return (
    <button
      onClick={isDisabled ? undefined : onClick}
      data-testid={`explorer-tab-${tab.id}`}
      data-active={isActive}
      title={isDisabled ? tab.disabledReason : undefined}
      className={`
        w-full px-3 py-3 text-left text-sm flex items-center gap-3
        transition-colors duration-100
        ${isDisabled
          ? 'opacity-40 cursor-not-allowed'
          : isActive
            ? 'bg-surface-1 text-ctp-text cursor-pointer'
            : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1 cursor-pointer'
        }
      `}
    >
      {tab.icon}
      <span className="flex-1">{tab.label}</span>
      {tabBadge && !isDisabled && <Badge type={tabBadge.type} value={tabBadge.value} inline />}
    </button>
  );
});

export function ExplorerRail() {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const { activeProjectId, activeProject, orderedTabs, setTabOrder } = useProjectTabs();

  // Drag-to-reorder state (mirrors ProjectRail pattern)
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

    const newOrder = [...orderedTabs];
    const [moved] = newOrder.splice(dragIndex, 1);
    newOrder.splice(dropIndex, 0, moved);

    setTabOrder(newOrder.map((t) => t.id));

    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, orderedTabs, setTabOrder]);

  // Early return AFTER all hooks to satisfy rules-of-hooks
  if (explorerTab === 'settings') {
    return <SettingsContextPicker />;
  }

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full min-h-0">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider truncate">
          {activeProject?.displayName || activeProject?.name || 'No Project'}
        </h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col min-h-0 overflow-y-auto">
        {orderedTabs.map((tab, i) => (
          <div
            key={tab.id}
            ref={dragIndex === i ? dragNodeRef : undefined}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
            className="relative"
          >
            {dragOverIndex === i && dragIndex !== null && dragIndex !== i && (
              <div className="absolute -top-0.5 left-3 right-3 h-0.5 bg-ctp-accent rounded-full" />
            )}
            <TabButton tab={tab} isActive={explorerTab === tab.id} projectId={activeProjectId} onClick={() => setExplorerTab(tab.id, activeProjectId ?? undefined)} />
          </div>
        ))}
      </nav>
    </div>
  );
}
