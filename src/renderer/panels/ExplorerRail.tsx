import { ReactNode } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../stores/pluginStore';
import { getAllPlugins } from '../plugins';

interface TabEntry { id: string; label: string; icon: ReactNode }

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
  {
    id: 'hub',
    label: 'Hub',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L8 8H4l2 6H4l8 8 8-8h-2l2-6h-4L12 2z" />
        <line x1="12" y1="22" x2="12" y2="16" />
      </svg>
    ),
  },
];

const SETTINGS_TAB: TabEntry = {
  id: 'settings',
  label: 'Settings',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

export function ExplorerRail() {
  const { explorerTab, setExplorerTab } = useUIStore();
  const { projects, activeProjectId } = useProjectStore();
  const isPluginEnabled = usePluginStore((s) => s.isPluginEnabled);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Build plugin tabs from registry, filtered by enabled state
  const pluginTabs: TabEntry[] = getAllPlugins()
    .filter((p) => activeProjectId ? isPluginEnabled(activeProjectId, p.id) : true)
    .map((p) => ({ id: p.id, label: p.label, icon: p.icon }));

  const topTabs = [...CORE_TABS, ...pluginTabs];

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider truncate">
          {activeProject?.name ?? 'No Project'}
        </h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col">
        {topTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setExplorerTab(tab.id)}
            className={`
              w-full px-3 py-3 text-left text-sm flex items-center gap-3
              transition-colors duration-100 cursor-pointer
              ${explorerTab === tab.id
                ? 'bg-surface-1 text-ctp-text'
                : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }
            `}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setExplorerTab(SETTINGS_TAB.id)}
          className={`
            w-full px-3 py-3 text-left text-sm flex items-center gap-3
            transition-colors duration-100 cursor-pointer border-t border-surface-0
            ${explorerTab === 'settings'
              ? 'bg-surface-1 text-ctp-text'
              : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
            }
          `}
        >
          {SETTINGS_TAB.icon}
          {SETTINGS_TAB.label}
        </button>
      </nav>
    </div>
  );
}
