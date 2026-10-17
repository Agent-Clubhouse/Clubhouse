import { useState, useEffect, useCallback } from 'react';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';
import { activatePlugin, deactivatePlugin, refreshCommunityPlugins } from '../../plugins/plugin-loader';
import { CANVAS_SUB_PLUGIN_IDS } from '../../plugins/builtin';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import type { PluginRegistryEntry } from '../../../shared/plugin-types';
import type { CustomMarketplace } from '../../../shared/marketplace-types';
import { PluginMarketplaceDialog } from './PluginMarketplaceDialog';
import { PluginStatusLines } from './PluginStatusLines';
import { showConfirmDialog } from '../../plugins/PluginDialog';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsButton, settingsInput, settingsHelp } from './SettingsLayout';

/** Plain source word shown in a plugin's meta line. */
export function pluginSourceLabel(entry: PluginRegistryEntry): string | null {
  if (entry.source === 'builtin') return 'Built-in';
  if (entry.source === 'marketplace') return 'Official';
  if (entry.source === 'community') return 'Community';
  return null;
}

/** "Built-in · 1.0.0" */
export function pluginMetaText(entry: PluginRegistryEntry): string {
  const source = pluginSourceLabel(entry);
  return [source, entry.manifest.version].filter(Boolean).join(' · ');
}

/**
 * Enable/disable logic shared by the plugin list and the plugin detail page.
 * Scope follows the settings context: app-wide in app settings, per project
 * in a project's settings.
 */
export function usePluginEnableToggle() {
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const enableForProject = usePluginStore((s) => s.enableForProject);
  const disableForProject = usePluginStore((s) => s.disableForProject);
  const enableApp = usePluginStore((s) => s.enableApp);
  const disableApp = usePluginStore((s) => s.disableApp);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const projects = useProjectStore((s) => s.projects);

  const isAppContext = settingsContext === 'app';
  const projectId = isAppContext ? undefined : settingsContext;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

  const isEnabled = (pluginId: string): boolean => {
    if (isAppContext) {
      return appEnabled.includes(pluginId);
    }
    return projectId ? (projectEnabled[projectId] || []).includes(pluginId) : false;
  };

  const toggle = async (pluginId: string) => {
    const enabled = isEnabled(pluginId);
    if (enabled) {
      // When disabling canvas, also disable its sub-plugins
      const idsToDisable = pluginId === 'canvas'
        ? [pluginId, ...Array.from(CANVAS_SUB_PLUGIN_IDS).filter((id) => isEnabled(id))]
        : [pluginId];
      for (const id of idsToDisable) {
        if (isAppContext) {
          await deactivatePlugin(id);
          disableApp(id);
        } else if (projectId) {
          await deactivatePlugin(id, projectId);
          disableForProject(projectId, id);
        }
      }
      // Persist
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? appEnabled.filter((id) => !idsToDisable.includes(id))
          : (projectEnabled[projectId!] || []).filter((id) => !idsToDisable.includes(id));
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
        if (entry?.status === 'disabled' || entry?.status === 'errored') {
          usePluginStore.getState().setPluginStatus(pluginId, 'registered');
        }
        enableApp(pluginId);
        // Only activate app/dual plugins immediately — project-scoped plugins
        // need a project context and will be activated by handleProjectSwitch.
        if (entry && entry.manifest.scope !== 'project') {
          await activatePlugin(pluginId);
        }
        // When enabling canvas, also cascade-enable its sub-plugins
        // (symmetric with cascade-disable on canvas off)
        if (pluginId === 'canvas') {
          for (const subId of CANVAS_SUB_PLUGIN_IDS) {
            if (!isEnabled(subId)) {
              const subEntry = usePluginStore.getState().plugins[subId];
              if (subEntry?.status === 'disabled') {
                usePluginStore.getState().setPluginStatus(subId, 'registered');
              }
              enableApp(subId);
              if (subEntry && subEntry.manifest.scope !== 'project') {
                await activatePlugin(subId);
              }
            }
          }
        }
      } else if (projectId) {
        const entry = usePluginStore.getState().plugins[pluginId];
        if (entry?.status === 'errored') {
          usePluginStore.getState().setPluginStatus(pluginId, 'registered');
        }
        enableForProject(projectId, pluginId);
        const projectPath = project?.path;
        await activatePlugin(pluginId, projectId, projectPath);
      }
      // Persist — read current state to capture any cascade-enabled sub-plugins
      try {
        const key = isAppContext ? 'app-enabled' : `project-enabled-${projectId}`;
        const currentList = isAppContext
          ? usePluginStore.getState().appEnabled
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

  return { isEnabled, toggle };
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** What a plugin has injected into a specific project. */
interface ProjectInjections {
  skills: string[];
  agentTemplates: string[];
  hasInstructions: boolean;
  permissionAllowCount: number;
  permissionDenyCount: number;
  mcpServerNames: string[];
}

function hasAnyInjections(inj: ProjectInjections): boolean {
  return (
    inj.skills.length > 0 ||
    inj.agentTemplates.length > 0 ||
    inj.hasInstructions ||
    inj.permissionAllowCount > 0 ||
    inj.permissionDenyCount > 0 ||
    inj.mcpServerNames.length > 0
  );
}

/**
 * Shown in project context when uninstalled plugins left injections behind.
 * Provides a one-click cleanup for each orphaned plugin.
 */
function OrphanInjectionsBanner({
  projectPath,
  knownPluginIds,
}: {
  projectPath: string;
  knownPluginIds: string[];
}) {
  const [orphans, setOrphans] = useState<string[] | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);

  const knownPluginIdsSerialized = JSON.stringify(knownPluginIds.slice().sort());
  const load = useCallback(async () => {
    try {
      const ids = await window.clubhouse.plugin.listOrphanedPluginIds(projectPath, knownPluginIds);
      setOrphans(ids);
    } catch {
      setOrphans([]);
    }
  }, [projectPath, knownPluginIdsSerialized]);

  useEffect(() => {
    load();
  }, [load]);

  if (!orphans || orphans.length === 0) return null;

  const handleClean = async (pluginId: string) => {
    setCleaning(pluginId);
    try {
      await window.clubhouse.plugin.cleanupProjectInjections(pluginId, projectPath);
      await load();
    } catch {
      // ignore
    } finally {
      setCleaning(null);
    }
  };

  const handleCleanAll = async () => {
    for (const id of orphans) {
      setCleaning(id);
      try {
        await window.clubhouse.plugin.cleanupProjectInjections(id, projectPath);
      } catch { /* ignore */ }
    }
    setCleaning(null);
    await load();
  };

  return (
    <SettingsSection
      title="Left behind by removed plugins"
      meta={String(orphans.length)}
      actions={orphans.length > 1 ? (
        <button
          onClick={handleCleanAll}
          disabled={cleaning !== null}
          className={settingsButton.ghost}
          data-testid="clean-all-orphans-btn"
        >
          {cleaning ? 'Cleaning…' : 'Clean all'}
        </button>
      ) : undefined}
    >
      <div data-testid="orphan-injections-banner">
        <p className="text-xs text-ctp-warning mb-1.5">
          These uninstalled plugins left skills, instructions, permissions or MCP servers in this project.
        </p>
        {orphans.map((id) => (
          <div key={id} className="flex items-center gap-3 h-9 border-t border-surface-0">
            <span className="flex-1 min-w-0 truncate text-xs font-mono text-ctp-text">{id}</span>
            <button
              onClick={() => handleClean(id)}
              disabled={cleaning !== null}
              className={settingsButton.ghost}
              data-testid={`clean-orphan-btn-${id}`}
            >
              {cleaning === id ? 'Cleaning…' : 'Clean up'}
            </button>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function PluginInjectionsPanel({
  pluginId,
  projectPath,
  onCleaned,
}: {
  pluginId: string;
  projectPath: string;
  onCleaned?: () => void;
}) {
  const [injections, setInjections] = useState<ProjectInjections | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await window.clubhouse.plugin.listProjectInjections(pluginId, projectPath);
      setInjections(data);
    } catch {
      setInjections(null);
    }
  }, [pluginId, projectPath]);

  useEffect(() => {
    load();
  }, [load]);

  if (!injections || !hasAnyInjections(injections)) return null;

  const handleClean = async () => {
    setCleaning(true);
    setCleanError(null);
    try {
      await window.clubhouse.plugin.cleanupProjectInjections(pluginId, projectPath);
      await load();
      onCleaned?.();
    } catch (err) {
      setCleanError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

  const parts: string[] = [
    ...injections.skills.map((s) => `skill ${s}`),
    ...injections.agentTemplates.map((t) => `agent template ${t}`),
    ...(injections.hasInstructions ? ['agent instructions'] : []),
    ...(injections.permissionAllowCount > 0
      ? [`${injections.permissionAllowCount} allow rule${injections.permissionAllowCount !== 1 ? 's' : ''}`]
      : []),
    ...(injections.permissionDenyCount > 0
      ? [`${injections.permissionDenyCount} deny rule${injections.permissionDenyCount !== 1 ? 's' : ''}`]
      : []),
    ...injections.mcpServerNames.map((m) => `MCP server ${m}`),
  ];

  return (
    <div className="mt-1 flex items-center gap-3" data-testid={`injections-panel-${pluginId}`}>
      <p className="flex-1 min-w-0 text-xs text-ctp-overlay1">
        Added {parts.join(', ')} to this project.
        {cleanError && <span className="text-ctp-error"> {cleanError}</span>}
      </p>
      <button
        onClick={handleClean}
        disabled={cleaning}
        className={settingsButton.quiet}
        data-testid={`clean-injections-btn-${pluginId}`}
      >
        {cleaning ? 'Removing…' : 'Remove all'}
      </button>
    </div>
  );
}

function PluginRow({
  entry,
  enabled,
  onToggle,
  onOpenSettings,
  onUninstall,
  projectPath,
}: {
  entry: PluginRegistryEntry;
  enabled: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  onUninstall?: () => void;
  /** When set, shows what this plugin added to the project */
  projectPath?: string;
}) {
  const id = entry.manifest.id;
  const name = entry.manifest.name;
  const isIncompatible = entry.status === 'incompatible';

  return (
    <div className="py-2 border-t border-surface-0" data-testid={`plugin-row-${id}`}>
      <div className="flex items-center gap-4 min-h-9">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[13px] text-ctp-text truncate">{name}</span>
            <span className="text-xs text-ctp-overlay1 whitespace-nowrap" data-testid={`plugin-meta-${id}`}>
              {pluginMetaText(entry)}
            </span>
          </div>
          {entry.manifest.description && (
            <p className="text-xs text-ctp-overlay1 mt-px truncate">{entry.manifest.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onOpenSettings}
            className={settingsButton.icon}
            title="Plugin settings"
            aria-label={`${name} settings`}
            data-testid={`plugin-settings-btn-${id}`}
          >
            <GearIcon />
          </button>
          {onUninstall && (
            <button
              onClick={onUninstall}
              className={settingsButton.icon}
              title="Uninstall plugin"
              aria-label={`Uninstall ${name}`}
            >
              <TrashIcon />
            </button>
          )}
          <Toggle
            checked={enabled}
            onChange={onToggle}
            disabled={isIncompatible}
            ariaLabel={name}
          />
        </div>
      </div>

      {/* One plain line per thing that needs action. Nothing when all is well. */}
      <PluginStatusLines entry={entry} />
      {projectPath && (
        <PluginInjectionsPanel pluginId={id} projectPath={projectPath} />
      )}
    </div>
  );
}

function CustomMarketplaceManager() {
  const [marketplaces, setMarketplaces] = useState<CustomMarketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const loadMarketplaces = async () => {
    try {
      const list = await window.clubhouse.marketplace.listCustomMarketplaces();
      setMarketplaces(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMarketplaces();
  }, []);

  const handleAdd = async () => {
    if (!addName.trim() || !addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await window.clubhouse.marketplace.addCustomMarketplace({
        name: addName.trim(),
        url: addUrl.trim(),
      });
      setAddName('');
      setAddUrl('');
      await loadMarketplaces();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : 'Failed to add marketplace');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    const m = marketplaces.find((x) => x.id === id);
    if (!m) return;
    const { promise } = showConfirmDialog(`Remove custom marketplace "${m.name}"?`);
    const confirmed = await promise;
    if (!confirmed) return;
    try {
      await window.clubhouse.marketplace.removeCustomMarketplace({ id });
      await loadMarketplaces();
    } catch {
      // ignore
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await window.clubhouse.marketplace.toggleCustomMarketplace({ id, enabled });
      await loadMarketplaces();
    } catch {
      // ignore
    }
  };

  if (loading) return null;

  return (
    <SettingsSection title="Plugin stores" meta={String(marketplaces.length)}>
      <div data-testid="custom-marketplace-section">
        <p className={`${settingsHelp} mb-2`}>
          Private or third-party registries to discover, install and update plugins from.
          Each store hosts a <code className="font-mono text-ctp-subtext1">registry.json</code> in the Workshop format.
        </p>
        {marketplaces.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-4 min-h-[46px] py-2 border-t border-surface-0"
            data-testid={`custom-marketplace-${m.id}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] text-ctp-text">{m.name}</span>
                {!m.enabled && <span className="text-xs text-ctp-overlay1">Off</span>}
              </div>
              <p className="text-xs text-ctp-overlay1 truncate mt-px" title={m.url}>{m.url}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => handleRemove(m.id)}
                className={settingsButton.icon}
                title="Remove marketplace"
                aria-label={`Remove ${m.name}`}
              >
                <CloseIcon />
              </button>
              <Toggle
                checked={m.enabled}
                onChange={(v) => handleToggle(m.id, v)}
                ariaLabel={`Use ${m.name}`}
              />
            </div>
          </div>
        ))}
        <SettingsBlock>
          <div className="flex gap-2">
            <input
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Store name"
              aria-label="Store name"
              className={`${settingsInput} flex-1 min-w-0`}
              data-testid="custom-marketplace-name"
            />
            <input
              type="text"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              placeholder="Registry URL, e.g. https://…/registry.json"
              aria-label="Registry URL"
              className={`${settingsInput} flex-[2] min-w-0`}
              data-testid="custom-marketplace-url"
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            />
            <button
              onClick={handleAdd}
              disabled={adding || !addName.trim() || !addUrl.trim()}
              className={settingsButton.ghost}
              data-testid="custom-marketplace-add"
            >
              {adding ? 'Adding…' : 'Add store'}
            </button>
          </div>
          {addError && <p className="text-xs text-ctp-error mt-1.5">{addError}</p>}
        </SettingsBlock>
      </div>
    </SettingsSection>
  );
}

export function PluginListSettings() {
  const plugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const externalPluginsEnabled = usePluginStore((s) => s.externalPluginsEnabled);
  const showBetaPlugins = usePluginStore((s) => s.showBetaPlugins);
  const setShowBetaPlugins = usePluginStore((s) => s.setShowBetaPlugins);
  const disableApp = usePluginStore((s) => s.disableApp);
  const setExternalPluginsEnabled = usePluginStore((s) => s.setExternalPluginsEnabled);
  const openPluginSettings = useUIStore((s) => s.openPluginSettings);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);
  const { isEnabled, toggle: handleToggle } = usePluginEnableToggle();

  // Plugin update state
  const updates = usePluginUpdateStore((s) => s.updates);
  const updating = usePluginUpdateStore((s) => s.updating);
  const checking = usePluginUpdateStore((s) => s.checking);
  const lastCheck = usePluginUpdateStore((s) => s.lastCheck);
  const checkForUpdates = usePluginUpdateStore((s) => s.checkForUpdates);
  const updateAll = usePluginUpdateStore((s) => s.updateAll);

  const [restartHint, setRestartHint] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [storesOpen, setStoresOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  // Auto-refresh community plugins on mount so the list is always current.
  // Pass active project context so project-scoped plugins re-activate
  // for the current project (Mission 69). Mount-only effect — capturing
  // initial activeProjectId is intentional.
  useEffect(() => {
    if (externalPluginsEnabled) {
      const activeProj = activeProjectId
        ? projects.find((p) => p.id === activeProjectId)
        : undefined;
      refreshCommunityPlugins({
        activeProjectId: activeProjectId ?? undefined,
        activeProjectPath: activeProj?.path,
      }).catch(() => {});
    }
  }, []);

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
  // Hide canvas sub-plugins (group-project, sticky-note) unless canvas is enabled;
  // also hide plugins that require MCP when MCP is off
  const canvasEnabled = appEnabled.includes('canvas');
  const builtinPlugins = filteredPlugins.filter((e) => {
    if (e.source !== 'builtin') return false;
    if (CANVAS_SUB_PLUGIN_IDS.has(e.manifest.id) && !canvasEnabled) return false;
    if (e.manifest.requiresMcp && !mcpEnabled) return false;
    return true;
  });
  const externalPlugins = filteredPlugins.filter((e) => e.source === 'community' || e.source === 'marketplace');

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
    // Mission 69: When enabling the external master flag, immediately
    // discover and re-activate any previously-enabled external plugins
    // (including project-scope ones for the current project). Without
    // this, users had to manually click "Reload Local Plugins" and then
    // navigate away/back to a project to see their plugins return.
    if (newValue) {
      const activeProj = activeProjectId
        ? projects.find((p) => p.id === activeProjectId)
        : undefined;
      try {
        await refreshCommunityPlugins({
          activeProjectId: activeProjectId ?? undefined,
          activeProjectPath: activeProj?.path,
        });
      } catch { /* best effort */ }
    }
  };

  const handleBetaPluginsToggle = async () => {
    const newValue = !showBetaPlugins;
    setShowBetaPlugins(newValue);
    try {
      await window.clubhouse.marketplace.saveMarketplaceSettings({ showBetaPlugins: newValue });
    } catch { /* ignore */ }
  };

  const handleUninstall = async (pluginId: string) => {
    const entry = usePluginStore.getState().plugins[pluginId];
    if (!entry || entry.source === 'builtin') return;
    const { promise } = showConfirmDialog(`Uninstall "${entry.manifest.name}"? This will delete the plugin and clean up all its project injections.`);
    const confirmed = await promise;
    if (!confirmed) return;
    // Deactivate first if active
    await deactivatePlugin(pluginId);
    disableApp(pluginId);
    // Clean up project-level injections across all known projects (best-effort)
    const allProjects = useProjectStore.getState().projects;
    for (const proj of allProjects) {
      if (proj.path) {
        try {
          await window.clubhouse.plugin.cleanupProjectInjections(pluginId, proj.path);
        } catch { /* ignore */ }
      }
    }
    // Delete plugin from disk
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
    const { promise } = showConfirmDialog(`Uninstall all ${externalPlugins.length} external plugin(s)? This will delete them from disk and clean up their project injections.`);
    const confirmed = await promise;
    if (!confirmed) return;
    const allProjects = useProjectStore.getState().projects;
    for (const entry of externalPlugins) {
      await deactivatePlugin(entry.manifest.id);
      disableApp(entry.manifest.id);
      // Clean up project-level injections across all known projects (best-effort)
      for (const proj of allProjects) {
        if (proj.path) {
          try {
            await window.clubhouse.plugin.cleanupProjectInjections(entry.manifest.id, proj.path);
          } catch { /* ignore */ }
        }
      }
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

  const handleScanNewPlugins = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const activeProj = activeProjectId
        ? projects.find((p) => p.id === activeProjectId)
        : undefined;
      const result = await refreshCommunityPlugins({
        activeProjectId: activeProjectId ?? undefined,
        activeProjectPath: activeProj?.path,
      });
      const parts: string[] = [];
      if (result.discovered.length > 0) {
        parts.push(`${result.discovered.length} new plugin(s) found`);
      }
      if (result.activated.length > 0) {
        parts.push(`${result.activated.length} plugin(s) activated`);
      }
      if (result.incompatible.length > 0) {
        parts.push(`${result.incompatible.length} plugin(s) incompatible with this version`);
      }
      if (parts.length === 0) {
        const refreshCount = result.refreshed.length;
        setScanResult(refreshCount > 0 ? `${refreshCount} plugin(s) up to date.` : 'No plugins found.');
      } else {
        setScanResult(parts.join(', ') + '.');
      }
    } catch {
      setScanResult('Failed to scan for plugins.');
    } finally {
      setScanning(false);
    }
  };


  const renderPluginList = (entries: PluginRegistryEntry[], showUninstall: boolean) => (
    <div>
      {entries.map((entry) => {
        return (
          <PluginRow
            key={entry.manifest.id}
            entry={entry}
            enabled={isEnabled(entry.manifest.id)}
            onToggle={() => handleToggle(entry.manifest.id)}
            onOpenSettings={() => openPluginSettings(entry.manifest.id)}
            onUninstall={showUninstall ? () => handleUninstall(entry.manifest.id) : undefined}
            projectPath={!isAppContext && project?.path ? project.path : undefined}
          />
        );
      })}
    </div>
  );

  const projectName = project?.displayName || project?.name || 'this project';

  const description = isAppContext ? (
    <>
      Turn plugins on for the app. Project plugins also need turning on in each project.
      Find and share plugins in the{' '}
      <a
        href="https://github.com/Agent-Clubhouse/Clubhouse-Workshop"
        target="_blank"
        rel="noopener noreferrer"
        className="text-ctp-accent hover:underline"
        data-testid="workshop-link"
      >
        Clubhouse Workshop
      </a>.
    </>
  ) : (
    `Turn plugins on for ${projectName}. Only plugins turned on for the app appear here. Install and remove plugins in app settings.`
  );

  const headerActions = isAppContext ? (
    <>
      <button
        onClick={() => setStoresOpen((v) => !v)}
        className={settingsButton.ghost}
        aria-expanded={storesOpen}
        data-testid="custom-marketplace-toggle"
      >
        Plugin stores…
      </button>
      <button
        onClick={() => setMarketplaceOpen(true)}
        className={settingsButton.primary}
        data-testid="marketplace-button"
      >
        Browse marketplace
      </button>
    </>
  ) : undefined;

  return (
    <SettingsPage title="Plugins" description={description} actions={headerActions}>
      {/* Custom plugin stores (app context only), opened from the header */}
      {isAppContext && storesOpen && <CustomMarketplaceManager />}

      {/* Orphaned injections (project context only) */}
      {!isAppContext && project?.path && (
        <OrphanInjectionsBanner
          projectPath={project.path}
          knownPluginIds={Object.keys(plugins)}
        />
      )}

      {builtinPlugins.length > 0 && (
        <SettingsSection title="Built-in" meta={String(builtinPlugins.length)}>
          {renderPluginList(builtinPlugins, false)}
        </SettingsSection>
      )}

      {isAppContext && (
        <>
          <SettingsSection title="From the marketplace" meta={String(externalPlugins.length)}>
            <SettingsField
              label="Allow external plugins"
              help={restartHint
                ? <span className="text-ctp-warning">Restart Clubhouse for this change to take full effect.</span>
                : 'Plugins from the Clubhouse Workshop and custom stores.'}
            >
              <span data-testid="external-plugins-toggle" className="inline-flex">
                <Toggle
                  checked={externalPluginsEnabled}
                  onChange={handleExternalToggle}
                  ariaLabel="Allow external plugins"
                />
              </span>
            </SettingsField>
            {externalPlugins.length > 0 ? (
              renderPluginList(externalPlugins, true)
            ) : (
              <SettingsBlock>
                <p className={settingsHelp}>
                  {externalPluginsEnabled
                    ? 'No external plugins installed. Browse the marketplace, or put plugins in ~/.clubhouse/plugins/ and restart.'
                    : 'Allow external plugins to find and load plugins from the marketplace.'}
                </p>
              </SettingsBlock>
            )}
          </SettingsSection>

          <SettingsSection title="Updates and local plugins">
            <SettingsField
              label="Plugin updates"
              help={lastCheck
                ? <span data-testid="last-check-time">Last checked {new Date(lastCheck).toLocaleString()}.</span>
                : 'Check the marketplace and your stores for newer versions.'}
            >
              {updates.length > 1 && (
                <button
                  onClick={updateAll}
                  disabled={Object.keys(updating).length > 0}
                  className={settingsButton.ghost}
                  data-testid="update-all-button"
                >
                  Update all ({updates.length})
                </button>
              )}
              <button
                onClick={checkForUpdates}
                disabled={checking}
                className={settingsButton.ghost}
                data-testid="check-updates-button"
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            </SettingsField>
            <SettingsField label="Beta versions" help="Offer beta versions from the official plugin registry.">
              <Toggle
                checked={showBetaPlugins}
                onChange={handleBetaPluginsToggle}
                ariaLabel="Show beta plugins"
              />
            </SettingsField>
            <SettingsField
              label="Local plugins"
              help={scanResult ?? <>Load plugins you put in <code className="font-mono">~/.clubhouse/plugins/</code>.</>}
            >
              <button
                onClick={handleScanNewPlugins}
                disabled={scanning}
                className={settingsButton.ghost}
                data-testid="scan-plugins-button"
              >
                {scanning ? 'Reloading…' : 'Reload'}
              </button>
            </SettingsField>
            {externalPlugins.length > 0 && (
              <SettingsField
                label="Uninstall all external plugins"
                help="Deletes them from disk and removes what they added to projects."
              >
                <button onClick={handleUninstallAll} className={settingsButton.danger}>
                  Uninstall all…
                </button>
              </SettingsField>
            )}
          </SettingsSection>
        </>
      )}

      {/* External plugins in project context (no master switch, no uninstall) */}
      {!isAppContext && externalPlugins.length > 0 && (
        <SettingsSection title="From the marketplace" meta={String(externalPlugins.length)}>
          {renderPluginList(externalPlugins, false)}
        </SettingsSection>
      )}

      {/* Empty state when no plugins at all */}
      {filteredPlugins.length === 0 && (
        <p className={`${settingsHelp} mt-4`}>
          No {isAppContext ? '' : 'project '}plugins installed.
          Put plugins in <code className="font-mono">~/.clubhouse/plugins/</code> and restart.
        </p>
      )}

      {marketplaceOpen && (
        <PluginMarketplaceDialog onClose={() => setMarketplaceOpen(false)} />
      )}
    </SettingsPage>
  );
}
