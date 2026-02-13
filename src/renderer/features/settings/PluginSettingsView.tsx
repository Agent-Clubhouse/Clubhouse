import { getAllPlugins } from '../../plugins';
import { usePluginStore } from '../../stores/pluginStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';

export function PluginSettingsView() {
  const plugins = getAllPlugins();
  const { activeProjectId, projects } = useProjectStore();
  const isPluginEnabled = usePluginStore((s) => s.isPluginEnabled);
  const setPluginEnabled = usePluginStore((s) => s.setPluginEnabled);
  const { explorerTab, setExplorerTab } = useUIStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  if (!activeProjectId || !activeProject) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0">No project selected</p>
      </div>
    );
  }

  const handleToggle = async (pluginId: string, enabled: boolean) => {
    await setPluginEnabled(activeProjectId, activeProject.path, pluginId, enabled);
    // If we just disabled the tab we're currently on, switch to agents
    if (!enabled && explorerTab === pluginId) {
      setExplorerTab('agents');
    }
  };

  return (
    <div className="h-full bg-ctp-base overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Plugins</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Enable or disable plugins for this project.
        </p>
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const enabled = isPluginEnabled(activeProjectId, plugin.id);
            return (
              <div
                key={plugin.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg bg-ctp-mantle border border-surface-0"
              >
                <div className="flex items-center gap-3">
                  <span className="text-ctp-subtext0">{plugin.icon}</span>
                  <span className="text-sm text-ctp-text font-medium">{plugin.label}</span>
                </div>
                <button
                  onClick={() => handleToggle(plugin.id, !enabled)}
                  className={`
                    relative w-10 h-5 rounded-full transition-colors duration-200 cursor-pointer
                    ${enabled ? 'bg-ctp-accent' : 'bg-surface-1'}
                  `}
                >
                  <span
                    className={`
                      absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                      ${enabled ? 'translate-x-5' : 'translate-x-0'}
                    `}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
