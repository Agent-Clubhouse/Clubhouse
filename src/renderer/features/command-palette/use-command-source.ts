import { useMemo, useState, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { usePanelStore } from '../../stores/panelStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useKeyboardShortcutsStore, formatBinding } from '../../stores/keyboardShortcutsStore';
import { useAnnexStore } from '../../stores/annexStore';
import { useProjectHubStore, useAppHubStore } from '../../plugins/builtin/hub/main';
import { pluginHotkeyRegistry } from '../../plugins/plugin-hotkeys';
import { pluginCommandRegistry } from '../../plugins/plugin-commands';
import { CommandItem, SETTINGS_PAGES } from './command-registry';

/** Hub metadata loaded from storage for non-active projects */
interface CrossProjectHub {
  hubId: string;
  hubName: string;
  projectId: string;
  projectName: string;
  projectPath: string;
}

/** Helper to get formatted shortcut string for a given shortcut ID */
function getShortcut(shortcuts: Record<string, { currentBinding: string }>, id: string): string | undefined {
  const def = shortcuts[id];
  return def ? formatBinding(def.currentBinding) : undefined;
}

const HUB_TAB = 'plugin:hub';

export function useCommandSource(): CommandItem[] {
  const projects = useProjectStore((s) => s.projects);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const agents = useAgentStore((s) => s.agents);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const setSettingsContext = useUIStore((s) => s.setSettingsContext);
  const toggleHelp = useUIStore((s) => s.toggleHelp);
  const openAbout = useUIStore((s) => s.openAbout);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const pluginsMap = usePluginStore((s) => s.plugins);
  const projectEnabled = usePluginStore((s) => s.projectEnabled);
  const shortcuts = useKeyboardShortcutsStore((s) => s.shortcuts);
  const toggleExplorerCollapse = usePanelStore((s) => s.toggleExplorerCollapse);
  const toggleAccessoryCollapse = usePanelStore((s) => s.toggleAccessoryCollapse);
  const annexSettings = useAnnexStore((s) => s.settings);
  const annexStatus = useAnnexStore((s) => s.status);
  const projectHubs = useProjectHubStore((s) => s.hubs);
  const projectActiveHubId = useProjectHubStore((s) => s.activeHubId);
  const appHubs = useAppHubStore((s) => s.hubs);
  const appActiveHubId = useAppHubStore((s) => s.activeHubId);

  // Load hubs from non-active projects so the palette shows all hubs
  const [otherProjectHubs, setOtherProjectHubs] = useState<CrossProjectHub[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function loadOtherHubs() {
      const entries: CrossProjectHub[] = [];
      for (const project of projects) {
        if (project.id === activeProjectId) continue;
        try {
          const instances = await window.clubhouse.plugin.storageRead({
            pluginId: 'hub',
            scope: 'project-local',
            key: 'hub-instances',
            projectPath: project.path,
          }) as { id: string; name: string }[] | null;
          if (Array.isArray(instances)) {
            for (const inst of instances) {
              entries.push({
                hubId: inst.id,
                hubName: inst.name,
                projectId: project.id,
                projectName: project.displayName || project.name,
                projectPath: project.path,
              });
            }
          }
        } catch { /* ignore read errors for individual projects */ }
      }
      if (!cancelled) setOtherProjectHubs(entries);
    }
    loadOtherHubs();
    return () => { cancelled = true; };
  }, [projects, activeProjectId]);

  return useMemo(() => {
    const items: CommandItem[] = [];

    // Projects
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      items.push({
        id: `project:${p.id}`,
        label: p.displayName || p.name,
        category: 'Projects',
        typeIndicator: '/',
        keywords: [p.name, p.path],
        detail: p.path,
        shortcut: getShortcut(shortcuts, `switch-project-${i + 1}`),
        execute: () => setActiveProject(p.id),
      });
    }

    // Agents — first 9 durable agents get switch-agent-N shortcuts
    let durableIdx = 0;

    for (const [agentId, agent] of Object.entries(agents)) {
      const project = projects.find((p) => p.id === agent.projectId);
      const isDurableInActive = agent.projectId === activeProjectId && agent.kind === 'durable';
      let agentShortcut: string | undefined;

      if (isDurableInActive) {
        durableIdx++;
        if (durableIdx <= 9) {
          agentShortcut = getShortcut(shortcuts, `switch-agent-${durableIdx}`);
        }
      }

      items.push({
        id: `agent:${agentId}`,
        label: agent.name,
        category: 'Agents',
        typeIndicator: '@',
        keywords: [project?.displayName || project?.name || ''],
        detail: project?.displayName || project?.name,
        shortcut: agentShortcut,
        execute: () => {
          setActiveProject(agent.projectId);
          setExplorerTab('agents', agent.projectId);
          setActiveAgent(agentId, agent.projectId);
        },
      });
    }

    // Hubs — resolve ALL hubs across all projects + app
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const activeProjectLabel = activeProject?.displayName || activeProject?.name;

    // Project hubs (active project — from reactive store)
    if (activeProjectId) {
      for (const hub of projectHubs) {
        items.push({
          id: `hub:project:${hub.id}`,
          label: hub.name,
          category: 'Hubs',
          typeIndicator: '#',
          keywords: ['hub', 'tab', 'workspace', activeProjectLabel || ''],
          detail: hub.id === projectActiveHubId ? 'Active' : activeProjectLabel,
          execute: () => {
            setActiveProject(activeProjectId);
            setExplorerTab(HUB_TAB, activeProjectId);
            useProjectHubStore.getState().setActiveHub(hub.id);
          },
        });
      }
    }

    // Hubs from other (non-active) projects — loaded from storage
    for (const entry of otherProjectHubs) {
      items.push({
        id: `hub:project:${entry.projectId}:${entry.hubId}`,
        label: entry.hubName,
        category: 'Hubs',
        typeIndicator: '#',
        keywords: ['hub', 'tab', 'workspace', entry.projectName],
        detail: entry.projectName,
        execute: async () => {
          // Pre-write the desired active hub to storage so loadHub picks it up
          await window.clubhouse.plugin.storageWrite({
            pluginId: 'hub',
            scope: 'project-local',
            key: 'hub-active-id',
            value: entry.hubId,
            projectPath: entry.projectPath,
          });
          setActiveProject(entry.projectId);
          setExplorerTab(HUB_TAB, entry.projectId);
        },
      });
    }

    // App-level hubs (always shown)
    for (const hub of appHubs) {
      items.push({
        id: `hub:app:${hub.id}`,
        label: hub.name,
        category: 'Hubs',
        typeIndicator: '#',
        keywords: ['hub', 'tab', 'workspace', 'home', 'app'],
        detail: hub.id === appActiveHubId && !activeProjectId ? 'Active' : 'Home',
        execute: () => {
          setActiveProject(null);
          setExplorerTab(HUB_TAB);
          useAppHubStore.getState().setActiveHub(hub.id);
        },
      });
    }

    // Navigation (plugin tabs for active project)
    if (activeProjectId) {
      const enabledPluginIds = projectEnabled[activeProjectId] || [];
      for (const pluginId of enabledPluginIds) {
        const entry = pluginsMap[pluginId];
        const tabLabel = entry?.manifest.contributes?.tab?.label;
        if (tabLabel) {
          items.push({
            id: `nav:plugin:${pluginId}`,
            label: `Go to ${tabLabel}`,
            category: 'Navigation',
            keywords: [pluginId],
            execute: () => setExplorerTab(`plugin:${pluginId}`, activeProjectId),
          });
        }
      }
    }

    // Navigation: core tabs
    items.push({
      id: 'nav:agents',
      label: 'Go to Agents',
      category: 'Navigation',
      execute: () => {
        if (activeProjectId) setExplorerTab('agents', activeProjectId);
      },
    });

    items.push({
      id: 'nav:home',
      label: 'Go to Home',
      category: 'Navigation',
      shortcut: getShortcut(shortcuts, 'go-home'),
      execute: () => setActiveProject(null),
    });

    items.push({
      id: 'nav:help',
      label: 'Open Help',
      category: 'Navigation',
      shortcut: getShortcut(shortcuts, 'toggle-help'),
      execute: () => toggleHelp(),
    });

    items.push({
      id: 'nav:about',
      label: 'Open About',
      category: 'Navigation',
      execute: () => openAbout(),
    });

    // Settings pages
    for (const sp of SETTINGS_PAGES) {
      const shortcutId = sp.page === 'display' ? 'toggle-settings' : undefined;
      const shortcutDef = shortcutId ? shortcuts[shortcutId] : undefined;
      items.push({
        id: `settings:${sp.page}`,
        label: sp.label,
        category: 'Settings',
        keywords: ['settings', 'preferences', 'config'],
        shortcut: shortcutDef ? formatBinding(shortcutDef.currentBinding) : undefined,
        execute: () => {
          const uiState = useUIStore.getState();
          if (uiState.explorerTab !== 'settings') {
            toggleSettings();
          }
          setSettingsContext('app');
          setSettingsSubPage(sp.page);
        },
      });
    }

    // Actions
    items.push({
      id: 'action:toggle-settings',
      label: 'Toggle Settings',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'toggle-settings'),
      execute: () => toggleSettings(),
    });

    items.push({
      id: 'action:toggle-sidebar',
      label: 'Toggle Sidebar',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'toggle-sidebar'),
      execute: () => toggleExplorerCollapse(),
    });

    items.push({
      id: 'action:toggle-accessory',
      label: 'Toggle Accessory Panel',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'toggle-accessory'),
      execute: () => toggleAccessoryCollapse(),
    });

    items.push({
      id: 'action:new-quick-agent',
      label: 'New Quick Agent',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'new-quick-agent'),
      keywords: ['agent', 'mission', 'quick'],
      execute: () => {
        useUIStore.getState().openQuickAgentDialog();
      },
    });

    items.push({
      id: 'action:add-project',
      label: 'Add Project',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'add-project'),
      keywords: ['new', 'open', 'folder'],
      execute: () => {
        useProjectStore.getState().pickAndAddProject();
      },
    });

    // Annex actions
    items.push({
      id: 'action:toggle-annex',
      label: annexSettings.enabled ? 'Disable Annex' : 'Enable Annex',
      category: 'Actions',
      keywords: ['annex', 'companion', 'ios', 'network'],
      execute: () => {
        useAnnexStore.getState().saveSettings({ ...annexSettings, enabled: !annexSettings.enabled });
      },
    });

    items.push({
      id: 'action:annex-show-pin',
      label: 'Show Annex PIN',
      category: 'Actions',
      keywords: ['annex', 'pairing', 'pin', 'companion'],
      detail: annexSettings.enabled && annexStatus.pin ? `PIN: ${annexStatus.pin}` : undefined,
      execute: () => {
        const uiState = useUIStore.getState();
        if (uiState.explorerTab !== 'settings') {
          toggleSettings();
        }
        setSettingsContext('app');
        setSettingsSubPage('annex');
      },
    });

    // Clubhouse Mode / Agent Config shortcut
    items.push({
      id: 'action:agent-config',
      label: 'Agent Config',
      category: 'Actions',
      keywords: ['clubhouse', 'mode', 'durable', 'agents', 'orchestrator', 'config'],
      execute: () => {
        const uiState = useUIStore.getState();
        if (uiState.explorerTab !== 'settings') {
          toggleSettings();
        }
        setSettingsContext('app');
        setSettingsSubPage('orchestrators');
      },
    });

    // Plugin commands (registered via commands.registerWithHotkey)
    for (const shortcut of pluginHotkeyRegistry.getAll()) {
      const pluginEntry = pluginsMap[shortcut.pluginId];
      const pluginName = pluginEntry?.manifest.name ?? shortcut.pluginId;
      items.push({
        id: `plugin-cmd:${shortcut.fullCommandId}`,
        label: shortcut.title,
        category: `Plugin: ${pluginName}`,
        keywords: [shortcut.pluginId, shortcut.commandId],
        shortcut: shortcut.currentBinding ? formatBinding(shortcut.currentBinding) : undefined,
        execute: () => {
          pluginCommandRegistry.execute(shortcut.fullCommandId).catch(() => {});
        },
      });
    }

    return items;
  }, [
    projects, agents, activeProjectId, pluginsMap, projectEnabled, shortcuts,
    annexSettings, annexStatus,
    projectHubs, projectActiveHubId, appHubs, appActiveHubId,
    otherProjectHubs,
    setActiveProject, setActiveAgent, setExplorerTab, toggleSettings,
    setSettingsSubPage, setSettingsContext, toggleHelp, openAbout,
    toggleExplorerCollapse, toggleAccessoryCollapse,
  ]);
}
