import { useMemo, useState, useEffect } from 'react';
import { useStore } from 'zustand';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { usePanelStore } from '../../stores/panelStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useKeyboardShortcutsStore, formatBinding } from '../../stores/keyboardShortcutsStore';
import { useAnnexStore } from '../../stores/annexStore';
import { getProjectHubStore, useAppHubStore } from '../../plugins/builtin/hub/main';
import { getProjectCanvasStore, useAppCanvasStore } from '../../plugins/builtin/canvas/main';
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

/** Canvas metadata loaded from storage for non-active projects */
interface CrossProjectCanvas {
  canvasId: string;
  canvasName: string;
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
const CANVAS_TAB = 'plugin:canvas';

export function useCommandSource(): CommandItem[] {
  const projects = useProjectStore((s) => s.projects);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const removeProject = useProjectStore((s) => s.removeProject);
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
  const currentProjectStore = getProjectHubStore(activeProjectId);
  const projectHubs = useStore(currentProjectStore, (s) => s.hubs);
  const projectActiveHubId = useStore(currentProjectStore, (s) => s.activeHubId);
  const appHubs = useAppHubStore((s) => s.hubs);
  const appActiveHubId = useAppHubStore((s) => s.activeHubId);
  const currentCanvasStore = getProjectCanvasStore(activeProjectId);
  const projectCanvases = useStore(currentCanvasStore, (s) => s.canvases);
  const projectActiveCanvasId = useStore(currentCanvasStore, (s) => s.activeCanvasId);
  const appCanvases = useAppCanvasStore((s) => s.canvases);
  const appActiveCanvasId = useAppCanvasStore((s) => s.activeCanvasId);
  const canvasPluginEnabled = usePluginStore((s) => s.appEnabled.includes('canvas'));

  // Annex is a stable feature — commands always available
  const [annexEnabled, setAnnexEnabled] = useState(false);
  useEffect(() => {
    window.clubhouse.app.isPreviewEligible().then((eligible) => {
      setAnnexEnabled(eligible);
    }).catch(() => {});
  }, []);

  // Load hubs from non-active projects so the palette shows all hubs
  const [otherProjectHubs, setOtherProjectHubs] = useState<CrossProjectHub[]>([]);
  // Load canvases from non-active projects
  const [otherProjectCanvases, setOtherProjectCanvases] = useState<CrossProjectCanvas[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function loadOtherSpaces() {
      const hubEntries: CrossProjectHub[] = [];
      const canvasEntries: CrossProjectCanvas[] = [];
      for (const project of projects) {
        if (project.id === activeProjectId) continue;
        // Load hubs
        try {
          const instances = await window.clubhouse.plugin.storageRead({
            pluginId: 'hub',
            scope: 'project-local',
            key: 'hub-instances',
            projectPath: project.path,
          }) as { id: string; name: string }[] | null;
          if (Array.isArray(instances)) {
            for (const inst of instances) {
              hubEntries.push({
                hubId: inst.id,
                hubName: inst.name,
                projectId: project.id,
                projectName: project.displayName || project.name,
                projectPath: project.path,
              });
            }
          }
        } catch { /* ignore read errors for individual projects */ }
        // Load canvases
        try {
          const instances = await window.clubhouse.plugin.storageRead({
            pluginId: 'canvas',
            scope: 'project-local',
            key: 'canvas-instances',
            projectPath: project.path,
          }) as { id: string; name: string }[] | null;
          if (Array.isArray(instances)) {
            for (const inst of instances) {
              canvasEntries.push({
                canvasId: inst.id,
                canvasName: inst.name,
                projectId: project.id,
                projectName: project.displayName || project.name,
                projectPath: project.path,
              });
            }
          }
        } catch { /* ignore read errors for individual projects */ }
      }
      if (!cancelled) {
        setOtherProjectHubs(hubEntries);
        setOtherProjectCanvases(canvasEntries);
      }
    }
    loadOtherSpaces();
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

    // Spaces — resolve ALL hubs and canvases across all projects + app
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const activeProjectLabel = activeProject?.displayName || activeProject?.name;

    // Project hubs (active project — from reactive store)
    if (activeProjectId) {
      for (const hub of projectHubs) {
        const context = hub.id === projectActiveHubId ? 'Active' : activeProjectLabel;
        items.push({
          id: `hub:project:${hub.id}`,
          label: hub.name,
          category: 'Spaces',
          typeIndicator: '#',
          keywords: ['hub', 'tab', 'workspace', 'space', activeProjectLabel || ''],
          detail: context ? `Hub · ${context}` : 'Hub',
          execute: () => {
            setActiveProject(activeProjectId);
            setExplorerTab(HUB_TAB, activeProjectId);
            getProjectHubStore(activeProjectId).getState().setActiveHub(hub.id);
          },
        });
      }
    }

    // Hubs from other (non-active) projects — loaded from storage
    for (const entry of otherProjectHubs) {
      items.push({
        id: `hub:project:${entry.projectId}:${entry.hubId}`,
        label: entry.hubName,
        category: 'Spaces',
        typeIndicator: '#',
        keywords: ['hub', 'tab', 'workspace', 'space', entry.projectName],
        detail: `Hub · ${entry.projectName}`,
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
      const context = hub.id === appActiveHubId && !activeProjectId ? 'Active' : 'Home';
      items.push({
        id: `hub:app:${hub.id}`,
        label: hub.name,
        category: 'Spaces',
        typeIndicator: '#',
        keywords: ['hub', 'tab', 'workspace', 'space', 'home', 'app'],
        detail: `Hub · ${context}`,
        execute: () => {
          setActiveProject(null);
          setExplorerTab(HUB_TAB);
          useAppHubStore.getState().setActiveHub(hub.id);
        },
      });
    }

    // Canvas items — only shown when canvas plugin is enabled
    if (canvasPluginEnabled) {
      // Project canvases (active project — from reactive store)
      if (activeProjectId) {
        for (const canvas of projectCanvases) {
          const context = canvas.id === projectActiveCanvasId ? 'Active' : activeProjectLabel;
          items.push({
            id: `canvas:project:${canvas.id}`,
            label: canvas.name,
            category: 'Spaces',
            typeIndicator: '#',
            keywords: ['canvas', 'workspace', 'space', activeProjectLabel || ''],
            detail: context ? `Canvas · ${context}` : 'Canvas',
            execute: () => {
              setActiveProject(activeProjectId);
              setExplorerTab(CANVAS_TAB, activeProjectId);
              getProjectCanvasStore(activeProjectId).getState().setActiveCanvas(canvas.id);
            },
          });
        }
      }

      // Canvases from other (non-active) projects — loaded from storage
      for (const entry of otherProjectCanvases) {
        items.push({
          id: `canvas:project:${entry.projectId}:${entry.canvasId}`,
          label: entry.canvasName,
          category: 'Spaces',
          typeIndicator: '#',
          keywords: ['canvas', 'workspace', 'space', entry.projectName],
          detail: `Canvas · ${entry.projectName}`,
          execute: async () => {
            await window.clubhouse.plugin.storageWrite({
              pluginId: 'canvas',
              scope: 'project-local',
              key: 'canvas-active-id',
              value: entry.canvasId,
              projectPath: entry.projectPath,
            });
            setActiveProject(entry.projectId);
            setExplorerTab(CANVAS_TAB, entry.projectId);
          },
        });
      }

      // App-level canvases
      for (const canvas of appCanvases) {
        const context = canvas.id === appActiveCanvasId && !activeProjectId ? 'Active' : 'Home';
        items.push({
          id: `canvas:app:${canvas.id}`,
          label: canvas.name,
          category: 'Spaces',
          typeIndicator: '#',
          keywords: ['canvas', 'workspace', 'space', 'home', 'app'],
          detail: `Canvas · ${context}`,
          execute: () => {
            setActiveProject(null);
            setExplorerTab(CANVAS_TAB);
            useAppCanvasStore.getState().setActiveCanvas(canvas.id);
          },
        });
      }
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
      id: 'nav:assistant',
      label: 'Open Assistant',
      category: 'Navigation',
      shortcut: getShortcut(shortcuts, 'toggle-assistant'),
      execute: () => useUIStore.getState().toggleAssistant(),
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

    if (activeProjectId) {
      items.push({
        id: 'action:close-project',
        label: 'Close Project',
        category: 'Actions',
        shortcut: getShortcut(shortcuts, 'close-project'),
        keywords: ['remove', 'delete', 'close', 'project'],
        execute: () => removeProject(activeProjectId),
      });
    }

    // Annex actions (only when experimental flag is enabled)
    if (annexEnabled) {
      items.push({
        id: 'action:toggle-annex-server',
        label: annexSettings.enableServer ? 'Disable Annex Server' : 'Enable Annex Server',
        category: 'Actions',
        keywords: ['annex', 'server', 'companion', 'ios', 'network', 'remote', 'control'],
        execute: () => {
          useAnnexStore.getState().saveSettings({ ...annexSettings, enableServer: !annexSettings.enableServer });
        },
      });

      items.push({
        id: 'action:toggle-annex-client',
        label: annexSettings.enableClient ? 'Disable Annex Client' : 'Enable Annex Client',
        category: 'Actions',
        keywords: ['annex', 'client', 'satellite', 'connect', 'network', 'discover'],
        execute: () => {
          useAnnexStore.getState().saveSettings({ ...annexSettings, enableClient: !annexSettings.enableClient });
        },
      });

      items.push({
        id: 'action:annex-show-pin',
        label: 'Show Annex PIN',
        category: 'Actions',
        keywords: ['annex', 'pairing', 'pin', 'companion'],
        detail: annexSettings.enableServer && annexStatus.pin ? `PIN: ${annexStatus.pin}` : undefined,
        execute: () => {
          const uiState = useUIStore.getState();
          if (uiState.explorerTab !== 'settings') {
            toggleSettings();
          }
          setSettingsContext('app');
          setSettingsSubPage('annex');
        },
      });
    }

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
    annexSettings, annexStatus, annexEnabled, canvasPluginEnabled,
    projectHubs, projectActiveHubId, appHubs, appActiveHubId,
    otherProjectHubs,
    projectCanvases, projectActiveCanvasId, appCanvases, appActiveCanvasId,
    otherProjectCanvases,
    setActiveProject, removeProject, setActiveAgent, setExplorerTab, toggleSettings,
    setSettingsSubPage, setSettingsContext, toggleHelp, openAbout,
    toggleExplorerCollapse, toggleAccessoryCollapse,
  ]);
}
