import { ReactNode, useState, useRef, useCallback, useMemo } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useBadgeStore } from '../stores/badgeStore';
import { Badge } from '../components/Badge';

interface TabEntry { id: string; label: string; icon: ReactNode }

const TAB_ORDER_KEY_PREFIX = 'clubhouse_explorer_tab_order_';

function loadTabOrder(projectId: string): string[] | null {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTabOrder(projectId: string, order: string[]): void {
  try {
    localStorage.setItem(TAB_ORDER_KEY_PREFIX + projectId, JSON.stringify(order));
  } catch { /* quota exceeded – silently ignore */ }
}

const CORE_TABS: TabEntry[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="4" />
        <circle cx="9" cy="16" r="1.5" fill="currentColor" />
        <circle cx="15" cy="16" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
];

function SettingsContextPicker() {
  const { settingsContext, setSettingsContext } = useUIStore();
  const { projects } = useProjectStore();

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Settings</h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col">
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
            <span className="w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold bg-surface-2 flex-shrink-0">
              {(p.displayName || p.name).charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{p.displayName || p.name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

const PLUGIN_FALLBACK_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

function TabButton({ tab, isActive, projectId, onClick }: { tab: TabEntry; isActive: boolean; projectId: string | null; onClick: () => void }) {
  const tabBadge = useBadgeStore((s) => projectId ? s.getTabBadge(projectId, tab.id) : null);

  return (
    <button
      onClick={onClick}
      data-testid={`explorer-tab-${tab.id}`}
      data-active={isActive}
      className={`
        w-full px-3 py-3 text-left text-sm flex items-center gap-3
        transition-colors duration-100 cursor-pointer
        ${isActive
          ? 'bg-surface-1 text-ctp-text'
          : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
        }
      `}
    >
      {tab.icon}
      <span className="flex-1">{tab.label}</span>
      {tabBadge && <Badge type={tabBadge.type} value={tabBadge.value} inline />}
    </button>
  );
}

export function ExplorerRail() {
  const { explorerTab, setExplorerTab } = useUIStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const plugins = usePluginStore((s) => s.plugins);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);

  // Get enabled project-scoped (and dual-scoped) plugins for the active project
  const enabledPluginIds = activeProjectId ? (projectEnabled[activeProjectId] || []) : [];
  const pluginTabs = enabledPluginIds
    .map((id) => plugins[id])
    .filter((entry) => entry && (entry.manifest.scope === 'project' || entry.manifest.scope === 'dual') && entry.status === 'activated' && entry.manifest.contributes?.tab);

  // Build unified tab list: core tabs + plugin tabs
  const pluginEntries: TabEntry[] = pluginTabs.map((entry) => ({
    id: `plugin:${entry.manifest.id}`,
    label: entry.manifest.contributes!.tab!.label,
    icon: entry.manifest.contributes!.tab!.icon
      ? <span dangerouslySetInnerHTML={{ __html: entry.manifest.contributes!.tab!.icon }} />
      : PLUGIN_FALLBACK_ICON,
  }));

  const rawTabs: TabEntry[] = [...CORE_TABS, ...pluginEntries];

  // Order version counter forces re-render after drag-drop reorder
  const [orderVersion, setOrderVersion] = useState(0);

  const orderedTabs = useMemo(() => {
    if (!activeProjectId) return rawTabs;
    const saved = loadTabOrder(activeProjectId);
    if (!saved) return rawTabs;

    const tabMap = new Map(rawTabs.map((t) => [t.id, t]));
    const ordered: TabEntry[] = [];

    // Pull tabs in saved order (skip IDs no longer present)
    for (const id of saved) {
      const tab = tabMap.get(id);
      if (tab) {
        ordered.push(tab);
        tabMap.delete(id);
      }
    }

    // Append any new tabs not in saved order
    for (const tab of tabMap.values()) {
      ordered.push(tab);
    }

    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, rawTabs.length, pluginTabs.length, orderVersion]);

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

    if (activeProjectId) {
      saveTabOrder(activeProjectId, newOrder.map((t) => t.id));
    }

    setDragIndex(null);
    setDragOverIndex(null);
    setOrderVersion((v) => v + 1);
  }, [dragIndex, orderedTabs, activeProjectId]);

  // Early return AFTER all hooks to satisfy rules-of-hooks
  if (explorerTab === 'settings') {
    return <SettingsContextPicker />;
  }

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider truncate">
          {activeProject?.displayName || activeProject?.name || 'No Project'}
        </h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col">
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
              <div className="absolute -top-0.5 left-3 right-3 h-0.5 bg-indigo-500 rounded-full" />
            )}
            <TabButton tab={tab} isActive={explorerTab === tab.id} projectId={activeProjectId} onClick={() => setExplorerTab(tab.id, activeProjectId ?? undefined)} />
          </div>
        ))}
      </nav>
    </div>
  );
}
