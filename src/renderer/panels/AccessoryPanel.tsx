import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useProjectStore } from '../stores/projectStore';
import { useUpdateStore } from '../stores/updateStore';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';
import { PluginAPIProvider } from '../plugins/plugin-context';
import { createPluginAPI } from '../plugins/plugin-api-factory';
import { getActiveContext } from '../plugins/plugin-loader';
import { PluginErrorBoundary } from './PluginContentView';
import { AgentList } from '../features/agents/AgentList';
import { SettingsSubPage } from '../../shared/types';
import { useFeedbackStore } from '../stores/feedbackStore';
import { useDispatcherFlagOn } from '../features/dispatcher/useDispatcherEnabled';


export interface SettingsCategory { label: string; page: SettingsSubPage }

/**
 * The settings categories, split into app-wide and per-project pages. Shared by
 * the legacy settings column and the new chrome's sidebar settings navigator.
 */
export function useSettingsCategories(): { app: SettingsCategory[]; project: SettingsCategory[] } {
  const previewChannel = useUpdateStore((s) => s.settings.previewChannel);
  const [showExperimental, setShowExperimental] = useState(false);
  const [showAnnex, setShowAnnex] = useState(false);
  const [showGoobers, setShowGoobers] = useState(false);
  // Follows dispatcher:changed, so the page shows and hides as the flag flips (#2555).
  const showDispatcher = useDispatcherFlagOn();
  const initFeedback = useFeedbackStore((s) => s.init);
  useEffect(() => { void initFeedback(); }, [initFeedback]);
  useEffect(() => {
    window.clubhouse.app.isPreviewEligible().then((isPreview) => {
      setShowExperimental(isPreview);
      // Annex is always available on preview-eligible builds
      setShowAnnex(isPreview);
    });
    window.clubhouse.app.getExperimentalSettings().then((s) => {
      setShowGoobers(!!s.goobers);
    });
  }, [previewChannel]);

  const app: SettingsCategory[] = [
    { label: 'About', page: 'about' },
    { label: 'Orchestrators & agents', page: 'orchestrators' },
    { label: 'Helpers', page: 'helpers' },
    ...(showDispatcher ? [{ label: 'Dispatcher', page: 'dispatcher' as SettingsSubPage }] : []),
    { label: 'Profiles', page: 'profiles' },
    { label: 'Display & UI', page: 'display' },
    { label: 'External editor', page: 'editor' },
    { label: 'Keyboard shortcuts', page: 'keyboard-shortcuts' },
    { label: 'Notifications & alerts', page: 'notifications' },
    { label: 'Plugins', page: 'plugins' },
    ...(showAnnex ? [{ label: 'Annex', page: 'annex' as SettingsSubPage }, { label: 'Annex control', page: 'annex-control' as SettingsSubPage }] : []),
    { label: 'Clubhouse MCP', page: 'mcp' },
    ...(showGoobers ? [{ label: 'Goobers', page: 'goobers' as SettingsSubPage }] : []),
    { label: 'Updates', page: 'updates' },
    { label: 'Logging', page: 'logging' },
    { label: 'Feedback', page: 'feedback' },
    ...(showExperimental ? [{ label: 'Experimental', page: 'experimental' as SettingsSubPage }] : []),
    { label: "What's new", page: 'whats-new' },
  ];
  const project: SettingsCategory[] = [
    { label: 'General', page: 'project' },
    { label: 'Orchestrators & agents', page: 'orchestrators' },
    { label: 'Notifications & alerts', page: 'notifications' },
    { label: 'Plugins', page: 'plugins' },
  ];
  return { app, project };
}

/** Whether `page` is the selected settings page (plugin detail counts as Plugins). */
export function isSettingsPageActive(current: SettingsSubPage, page: SettingsSubPage): boolean {
  return current === page || (page === 'plugins' && current === 'plugin-detail');
}

function SettingsCategoryNav() {
  const settingsContext = useUIStore((s) => s.settingsContext);
  const settingsSubPage = useUIStore((s) => s.settingsSubPage);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const { app, project } = useSettingsCategories();

  const navButton = ({ label, page }: SettingsCategory) => (
    <button
      key={page}
      onClick={() => setSettingsSubPage(page)}
      className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
        isSettingsPageActive(settingsSubPage, page)
          ? 'text-ctp-text bg-surface-1'
          : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
      }`}
    >
      {label}
    </button>
  );

  const isApp = settingsContext === 'app';

  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0">
          {isApp ? 'App settings' : 'Project settings'}
        </span>
      </div>
      <nav className="py-1 flex-1 flex flex-col min-h-0 overflow-y-auto">
        {(isApp ? app : project).map(navButton)}
      </nav>
    </div>
  );
}

function PluginSidebarPanel({ pluginId }: { pluginId: string }) {
  const mod = usePluginStore((s) => s.modules[pluginId]);
  const entry = usePluginStore((s) => s.plugins[pluginId]);
  const _contextRevision = usePluginStore((s) => s.contextRevision);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  if (!mod?.SidebarPanel) return null;

  const ctx = getActiveContext(pluginId, activeProjectId || undefined);
  if (!ctx) return null;

  const api = createPluginAPI(ctx, undefined, entry?.manifest);
  const SidebarPanel = mod.SidebarPanel;

  return (
    <PluginErrorBoundary key={pluginId} pluginId={pluginId}>
      <PluginAPIProvider api={api}>
        <SidebarPanel api={api} />
      </PluginAPIProvider>
    </PluginErrorBoundary>
  );
}

/**
 * `bare` drops the panel's own background and right border, for hosts that
 * already draw them (the new chrome's sidebar, spec #2023).
 */
export function AccessoryPanel({ bare = false }: { bare?: boolean } = {}) {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activePluginId = explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const activePluginEntry = usePluginStore((s) => activePluginId ? s.plugins[activePluginId] : undefined);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const pluginMatchState = useRemoteProjectStore((s) => s.pluginMatchState);
  const isRemoteProject = activeProjectId ? isRemoteProjectId(activeProjectId) : false;

  const frame = bare
    ? 'flex flex-col h-full min-h-0 overflow-hidden'
    : 'flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden';

  if (explorerTab === 'agents') {
    return (
      <div className={frame}>
        <AgentList />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    return <SettingsCategoryNav />;
  }

  // Plugin tabs with sidebar layout
  if (activePluginId) {
    // Security gate: block sidebar rendering for non-annex-enabled plugins on remote projects.
    // Only enforce once satellite snapshot has loaded (matches !== undefined).
    if (isRemoteProject && activeProjectId) {
      const parsed = parseNamespacedId(activeProjectId);
      if (parsed) {
        const matches = pluginMatchState[parsed.satelliteId];
        if (matches !== undefined) {
          const match = matches.find((p) => p.id === activePluginId);
          if (!match?.annexEnabled) {
            return null;
          }
        }
      }
    }

    const layout = activePluginEntry?.manifest.contributes?.tab?.layout ?? 'sidebar-content';

    if (layout === 'sidebar-content') {
      return (
        <div className={frame} data-testid="accessory-plugin-panel">
          <PluginSidebarPanel pluginId={activePluginId} />
        </div>
      );
    }
  }

  return null;
}
