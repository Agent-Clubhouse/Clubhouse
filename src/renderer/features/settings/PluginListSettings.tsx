import { useState, useRef, useEffect } from 'react';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { activatePlugin, deactivatePlugin } from '../../plugins/plugin-loader';
import type { PluginPermission, PluginRegistryEntry } from '../../../shared/plugin-types';
import { PERMISSION_DESCRIPTIONS } from '../../../shared/plugin-types';

function PermissionInfoPopup({ entry }: { entry: PluginRegistryEntry }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const permissions = entry.manifest.permissions;
  if (!permissions || permissions.length === 0) return null;

  const rect = btnRef.current?.getBoundingClientRect();

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold text-ctp-subtext0 hover:text-ctp-text bg-surface-1 hover:bg-surface-2 cursor-pointer"
        title="View permissions"
      >
        i
      </button>
      {open && (
        <div
          data-testid="permission-popup"
          className="fixed z-50 w-64 p-3 rounded-lg bg-ctp-mantle border border-surface-1 shadow-lg"
          style={rect ? { top: rect.bottom + 4, right: window.innerWidth - rect.right } : undefined}
        >
          <p className="text-xs font-semibold text-ctp-subtext1 mb-2">Permissions</p>
          <div className="space-y-1.5">
            {permissions.map((perm: PluginPermission) => (
              <div key={perm}>
                <span className="text-xs font-mono text-ctp-accent">{perm}</span>
                <p className="text-[10px] text-ctp-subtext0">{PERMISSION_DESCRIPTIONS[perm]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ entry }: { entry: PluginRegistryEntry }) {
  if (entry.source === 'builtin') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-accent/20 text-ctp-accent">Built-in</span>
    );
  }
  if (entry.source === 'community' && entry.manifest.official) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">Official</span>
    );
  }
  if (entry.source === 'community') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">Community</span>
    );
  }
  return null;
}

function PluginRow({
  entry,
  enabled,
  onToggle,
  onOpenSettings,
  onUninstall,
  hasSettings,
}: {
  entry: PluginRegistryEntry;
  enabled: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  onUninstall?: () => void;
  hasSettings: boolean;
}) {
  const isIncompatible = entry.status === 'incompatible';
  const isErrored = entry.status === 'errored';

  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg bg-ctp-mantle border border-surface-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ctp-text">{entry.manifest.name}</span>
          <span className="text-xs text-ctp-subtext0">v{entry.manifest.version}</span>
          <SourceBadge entry={entry} />
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-overlay1">API {entry.manifest.engine.api}</span>
          <PermissionInfoPopup entry={entry} />
          {isIncompatible && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Incompatible</span>
          )}
          {isErrored && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Error</span>
          )}
        </div>
        {entry.manifest.description && (
          <p className="text-xs text-ctp-subtext0 mt-0.5 truncate">{entry.manifest.description}</p>
        )}
        {entry.error && (() => {
          const newlineIdx = entry.error.indexOf('\n');
          const message = newlineIdx >= 0 ? entry.error.slice(0, newlineIdx) : entry.error;
          const stack = newlineIdx >= 0 ? entry.error.slice(newlineIdx + 1) : null;
          return (
            <div className="mt-1">
              <p className="text-xs text-red-400">{message}</p>
              {stack && (
                <details className="mt-1">
                  <summary className="text-[10px] text-red-400/70 cursor-pointer">View details</summary>
                  <pre className="text-[10px] text-red-400/70 bg-surface-0 p-2 rounded mt-1 overflow-auto max-h-32 whitespace-pre-wrap">{stack}</pre>
                </details>
              )}
            </div>
          );
        })()}
      </div>
      <div className="flex items-center gap-2 ml-3">
        {enabled && hasSettings && (
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
            title="Plugin settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        {onUninstall && (
          <button
            onClick={onUninstall}
            className="p-1.5 rounded hover:bg-red-500/10 text-ctp-subtext0 hover:text-red-400 cursor-pointer"
            title="Uninstall plugin"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
        <button
          onClick={onToggle}
          disabled={isIncompatible}
          className={`
            relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
            ${isIncompatible ? 'opacity-50 cursor-not-allowed' : ''}
            ${enabled ? 'bg-ctp-accent' : 'bg-surface-2'}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
              ${enabled ? 'translate-x-4' : 'translate-x-0'}
            `}
          />
        </button>
      </div>
    </div>
  );
}

export function PluginListSettings() {
  const plugins = usePluginStore((s) => s.plugins);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const externalPluginsEnabled = usePluginStore((s) => s.externalPluginsEnabled);
  const enableForProject = usePluginStore((s) => s.enableForProject);
  const disableForProject = usePluginStore((s) => s.disableForProject);
  const enableApp = usePluginStore((s) => s.enableApp);
  const disableApp = usePluginStore((s) => s.disableApp);
  const setExternalPluginsEnabled = usePluginStore((s) => s.setExternalPluginsEnabled);
  const openPluginSettings = useUIStore((s) => s.openPluginSettings);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);

  const [restartHint, setRestartHint] = useState(false);

  const isAppContext = settingsContext === 'app';
  const projectId = isAppContext ? undefined : settingsContext;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

  const allPlugins = Object.values(plugins);
  const filteredPlugins = allPlugins.filter((entry) => {
    if (isAppContext) {
      return true;
    }
    const scopeMatch = entry.manifest.scope === 'project' || entry.manifest.scope === 'dual';
    return scopeMatch && appEnabled.includes(entry.manifest.id);
  });

  // Split into builtin and external sections (local computation, safe from Zustand gotcha)
  const builtinPlugins = filteredPlugins.filter((e) => e.source === 'builtin');
  const externalPlugins = filteredPlugins.filter((e) => e.source === 'community');

  const isEnabled = (pluginId: string): boolean => {
    if (isAppContext) {
      return appEnabled.includes(pluginId);
    }
    return projectId ? (projectEnabled[projectId] || []).includes(pluginId) : false;
  };

  const handleToggle = async (pluginId: string) => {
    const enabled = isEnabled(pluginId);
    if (enabled) {
      if (isAppContext) {
        await deactivatePlugin(pluginId);
        disableApp(pluginId);
      } else if (projectId) {
        await deactivatePlugin(pluginId, projectId);
        disableForProject(projectId, pluginId);
      }
      // Persist
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? appEnabled.filter((id) => id !== pluginId)
          : (projectEnabled[projectId!] || []).filter((id) => id !== pluginId);
        await window.clubhouse.plugin.storageWrite({
          pluginId: '_system',
          scope: 'global',
          key,
          value: currentList,
        });
      } catch { /* ignore */ }
    } else {
      if (isAppContext) {
        const entry = usePluginStore.getState().plugins[pluginId];
        if (entry?.status === 'disabled') {
          usePluginStore.getState().setPluginStatus(pluginId, 'registered');
        }
        enableApp(pluginId);
        await activatePlugin(pluginId);
      } else if (projectId) {
        enableForProject(projectId, pluginId);
        const projectPath = project?.path;
        await activatePlugin(pluginId, projectId, projectPath);
      }
      // Persist
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? [...appEnabled, pluginId]
          : [...(projectEnabled[projectId!] || []), pluginId];
        await window.clubhouse.plugin.storageWrite({
          pluginId: '_system',
          scope: 'global',
          key,
          value: currentList,
        });
      } catch { /* ignore */ }
    }
  };

  const handleExternalToggle = async () => {
    const newValue = !externalPluginsEnabled;
    setExternalPluginsEnabled(newValue);
    setRestartHint(true);
    try {
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'external-plugins-enabled',
        value: newValue,
      });
    } catch { /* ignore */ }
  };

  const handleUninstall = async (pluginId: string) => {
    const entry = usePluginStore.getState().plugins[pluginId];
    if (!entry || entry.source === 'builtin') return;
    const confirmed = window.confirm(`Uninstall "${entry.manifest.name}"? This will delete the plugin from disk.`);
    if (!confirmed) return;
    // Deactivate first if active
    await deactivatePlugin(pluginId);
    disableApp(pluginId);
    // Delete from disk
    await window.clubhouse.plugin.uninstall(pluginId);
    // Remove from store
    usePluginStore.getState().removePlugin(pluginId);
    // Persist updated app-enabled list
    try {
      const updatedAppEnabled = usePluginStore.getState().appEnabled;
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: updatedAppEnabled,
      });
    } catch { /* ignore */ }
  };

  const handleUninstallAll = async () => {
    if (externalPlugins.length === 0) return;
    const confirmed = window.confirm(`Uninstall all ${externalPlugins.length} external plugin(s)? This will delete them from disk.`);
    if (!confirmed) return;
    for (const entry of externalPlugins) {
      await deactivatePlugin(entry.manifest.id);
      disableApp(entry.manifest.id);
      await window.clubhouse.plugin.uninstall(entry.manifest.id);
      usePluginStore.getState().removePlugin(entry.manifest.id);
    }
    try {
      const updatedAppEnabled = usePluginStore.getState().appEnabled;
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: updatedAppEnabled,
      });
    } catch { /* ignore */ }
  };

  const hasSettings = (entry: PluginRegistryEntry): boolean => {
    return !!(entry.manifest.settingsPanel || (entry.manifest.contributes?.settings && entry.manifest.contributes.settings.length > 0));
  };

  const renderPluginList = (entries: PluginRegistryEntry[], showUninstall: boolean) => (
    <div className="space-y-2">
      {entries.map((entry) => (
        <PluginRow
          key={entry.manifest.id}
          entry={entry}
          enabled={isEnabled(entry.manifest.id)}
          onToggle={() => handleToggle(entry.manifest.id)}
          onOpenSettings={() => openPluginSettings(entry.manifest.id)}
          onUninstall={showUninstall ? () => handleUninstall(entry.manifest.id) : undefined}
          hasSettings={hasSettings(entry)}
        />
      ))}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">
          {isAppContext ? 'Plugins' : 'Project Plugins'}
        </h2>
        <p className="text-xs text-ctp-subtext0 mb-4">
          {isAppContext
            ? 'Enable plugins to make them available. Project-scoped plugins also need to be enabled per project.'
            : `Enable plugins for ${project?.displayName || project?.name || 'this project'}. Only plugins enabled at the app level appear here.`}
        </p>
        {isAppContext && (
          <p className="text-xs text-ctp-subtext0 mb-6">
            Discover and share plugins at the{' '}
            <a
              href="https://github.com/Agent-Clubhouse/Clubhouse-Workshop"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ctp-accent hover:underline"
              data-testid="workshop-link"
            >
              Clubhouse Workshop
            </a>.
          </p>
        )}

        {/* Built-in section */}
        {builtinPlugins.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">Built-in</h3>
            {renderPluginList(builtinPlugins, false)}
          </>
        )}

        {/* Master switch + External section (app context only) */}
        {isAppContext && (
          <>
            <div className={`${builtinPlugins.length > 0 ? 'mt-6 pt-6 border-t border-surface-1' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider">External</h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ctp-subtext0">Enable External Plugins</span>
                  <button
                    onClick={handleExternalToggle}
                    className={`
                      relative w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer
                      ${externalPluginsEnabled ? 'bg-ctp-accent' : 'bg-surface-2'}
                    `}
                  >
                    <span
                      className={`
                        absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200
                        ${externalPluginsEnabled ? 'translate-x-4' : 'translate-x-0'}
                      `}
                    />
                  </button>
                </div>
              </div>
              <p className="text-xs text-ctp-subtext0 mb-3">
                Allow loading plugins from <code className="text-xs font-mono bg-surface-0 px-1 py-0.5 rounded">~/.clubhouse/plugins/</code>.
              </p>
              {restartHint && (
                <p className="text-xs text-ctp-peach mb-3">Restart Clubhouse for this change to take full effect.</p>
              )}
              {externalPlugins.length > 0 && (
                <button
                  onClick={handleUninstallAll}
                  className="text-[11px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer mb-3"
                >
                  Uninstall All
                </button>
              )}
            </div>

            {externalPlugins.length > 0 ? (
              renderPluginList(externalPlugins, true)
            ) : (
              <p className="text-xs text-ctp-subtext0">
                {externalPluginsEnabled
                  ? 'No external plugins installed. Place plugins in ~/.clubhouse/plugins/ and restart.'
                  : 'Enable external plugins above to discover and load community plugins.'}
              </p>
            )}
          </>
        )}

        {/* External section in project context (no master switch, no uninstall) */}
        {!isAppContext && externalPlugins.length > 0 && (
          <>
            {builtinPlugins.length > 0 && (
              <div className="mt-6 pt-6 border-t border-surface-1">
                <h3 className="text-xs font-semibold text-ctp-subtext1 uppercase tracking-wider mb-3">External</h3>
              </div>
            )}
            {renderPluginList(externalPlugins, false)}
          </>
        )}

        {/* Empty state when no plugins at all */}
        {filteredPlugins.length === 0 && (
          <p className="text-sm text-ctp-subtext0">
            No {isAppContext ? '' : 'project-scoped '}plugins installed.
            Place plugins in <code className="text-xs font-mono bg-surface-0 px-1 py-0.5 rounded">~/.clubhouse/plugins/</code> and restart.
          </p>
        )}
      </div>
    </div>
  );
}
