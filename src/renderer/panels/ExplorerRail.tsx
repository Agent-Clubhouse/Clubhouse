import { ReactNode } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';

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

export function ExplorerRail() {
  const { explorerTab, setExplorerTab } = useUIStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const plugins = usePluginStore((s) => s.plugins);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);

  if (explorerTab === 'settings') {
    return <SettingsContextPicker />;
  }

  // Get enabled project-scoped plugins for the active project
  const enabledPluginIds = activeProjectId ? (projectEnabled[activeProjectId] || []) : [];
  const pluginTabs = enabledPluginIds
    .map((id) => plugins[id])
    .filter((entry) => entry && entry.manifest.scope === 'project' && entry.status === 'activated' && entry.manifest.contributes?.tab);

  return (
    <div className="flex flex-col bg-ctp-mantle border-r border-surface-0 h-full">
      <div className="px-3 py-3 border-b border-surface-0">
        <h2 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider truncate">
          {activeProject?.displayName || activeProject?.name || 'No Project'}
        </h2>
      </div>
      <nav className="flex-1 py-1 flex flex-col">
        {CORE_TABS.map((tab) => (
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

        {pluginTabs.length > 0 && (
          <div className="mx-3 border-t border-surface-0 my-1" />
        )}

        {pluginTabs.map((entry) => {
          const tabId = `plugin:${entry.manifest.id}`;
          return (
            <button
              key={tabId}
              onClick={() => setExplorerTab(tabId)}
              className={`
                w-full px-3 py-3 text-left text-sm flex items-center gap-3
                transition-colors duration-100 cursor-pointer
                ${explorerTab === tabId
                  ? 'bg-surface-1 text-ctp-text'
                  : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
                }
              `}
            >
              {PLUGIN_FALLBACK_ICON}
              {entry.manifest.contributes!.tab!.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
