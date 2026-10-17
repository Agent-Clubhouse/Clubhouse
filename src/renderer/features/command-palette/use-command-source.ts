import { useMemo, useState, useEffect, useCallback } from 'react';
import { useStore } from 'zustand';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { usePanelStore } from '../../stores/panelStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useKeyboardShortcutsStore, formatBinding } from '../../stores/keyboardShortcutsStore';
import { useAnnexStore } from '../../stores/annexStore';
import { getProjectCanvasStore, getKnownProjectIds, useAppCanvasStore } from '../../plugins/builtin/canvas/main';
import { pluginHotkeyRegistry } from '../../plugins/plugin-hotkeys';
import { pluginCommandRegistry } from '../../plugins/plugin-commands';
import { CommandItem, SETTINGS_PAGES } from './command-registry';
import { openNewQuickAgent } from '../../chrome/startPage';
import { isNewChromeEnabled } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { groupProjectAgents } from '../../chrome/sidebar/treeModel';

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
  // Unbound (a user binding took its default) or not in this shell's set.
  return def?.currentBinding ? formatBinding(def.currentBinding) : undefined;
}

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

  // Load canvases from non-active projects (reactive via store subscriptions)
  const [otherProjectCanvases, setOtherProjectCanvases] = useState<CrossProjectCanvas[]>([]);

  // Build cross-project canvas entries from live Zustand stores (reactive)
  const refreshOtherCanvases = useCallback(() => {
    const canvasEntries: CrossProjectCanvas[] = [];
    for (const project of projects) {
      if (project.id === activeProjectId) continue;
      // Check if a live store exists for this project
      const knownIds = getKnownProjectIds();
      if (knownIds.includes(project.id)) {
        const store = getProjectCanvasStore(project.id);
        const canvases = store.getState().canvases;
        for (const canvas of canvases) {
          canvasEntries.push({
            canvasId: canvas.id,
            canvasName: canvas.name,
            projectId: project.id,
            projectName: project.displayName || project.name,
            projectPath: project.path,
          });
        }
      }
    }
    return canvasEntries;
  }, [projects, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    async function loadOtherSpaces() {
      const canvasEntries: CrossProjectCanvas[] = [];
      const knownIds = new Set(getKnownProjectIds());
      for (const project of projects) {
        if (project.id === activeProjectId) continue;
        // Load canvases from storage only for projects without a live store
        if (!knownIds.has(project.id)) {
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
      }
      if (!cancelled) {
        // Merge: storage-loaded canvases + live store canvases
        const liveCanvases = refreshOtherCanvases();
        setOtherProjectCanvases([...canvasEntries, ...liveCanvases]);
      }
    }
    loadOtherSpaces();
    return () => { cancelled = true; };
  }, [projects, activeProjectId, refreshOtherCanvases]);

  // Subscribe to canvas store changes for non-active projects (reactive updates)
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    for (const project of projects) {
      if (project.id === activeProjectId) continue;
      const knownIds = getKnownProjectIds();
      if (knownIds.includes(project.id)) {
        const store = getProjectCanvasStore(project.id);
        const unsub = store.subscribe(() => {
          setOtherProjectCanvases((prev) => {
            // Remove old entries for this project, add fresh ones from store
            const withoutProject = prev.filter((e) => e.projectId !== project.id);
            const canvases = store.getState().canvases;
            const fresh = canvases.map((canvas) => ({
              canvasId: canvas.id,
              canvasName: canvas.name,
              projectId: project.id,
              projectName: project.displayName || project.name,
              projectPath: project.path,
            }));
            return [...withoutProject, ...fresh];
          });
        });
        unsubs.push(unsub);
      }
    }
    return () => { unsubs.forEach((u) => u()); };
  }, [projects, activeProjectId]);

  // ── Category-specific memos ─────────────────────────────────────────
  // Split into narrow dependency groups so changing one category (e.g.
  // agents) doesn't rebuild the entire 400+ line command list.

  const projectItems = useMemo((): CommandItem[] => {
    return projects.map((p, i) => ({
      id: `project:${p.id}`,
      label: p.displayName || p.name,
      category: 'Projects',
      typeIndicator: '/',
      keywords: [p.name, p.path],
      detail: p.path,
      shortcut: getShortcut(shortcuts, `switch-project-${i + 1}`),
      execute: () => setActiveProject(p.id),
    }));
  }, [projects, shortcuts, setActiveProject]);

  const agentItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];
    // switch-agent-N numbers: durable agents in the legacy shell, the sidebar's
    // rows in the new one (command-actions.ts).
    const activeAgents = Object.values(agents).filter((a) => a.projectId === activeProjectId);
    let numbered: string[];
    if (isNewChromeEnabled()) {
      const { durable, quick, sleeping } = groupProjectAgents(activeAgents);
      numbered = [...durable, ...quick, ...sleeping].map((a) => a.id);
    } else {
      numbered = activeAgents.filter((a) => a.kind === 'durable').map((a) => a.id);
    }
    for (const [agentId, agent] of Object.entries(agents)) {
      const project = projects.find((p) => p.id === agent.projectId);
      const index = numbered.indexOf(agentId);
      const agentShortcut = index >= 0 && index < 9 ? getShortcut(shortcuts, `switch-agent-${index + 1}`) : undefined;
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
    return items;
  }, [agents, projects, activeProjectId, shortcuts, setActiveProject, setExplorerTab, setActiveAgent]);

  const spaceItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const activeProjectLabel = activeProject?.displayName || activeProject?.name;

    if (canvasPluginEnabled) {
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

    return items;
  }, [
    projects, activeProjectId, canvasPluginEnabled,
    projectCanvases, projectActiveCanvasId, appCanvases, appActiveCanvasId, otherProjectCanvases,
    setActiveProject, setExplorerTab,
  ]);

  const navigationItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];

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

    items.push({
      id: 'nav:agents',
      label: 'Go to Agents',
      category: 'Navigation',
      execute: () => { if (activeProjectId) setExplorerTab('agents', activeProjectId); },
    });
    // The new shell has no Home (spec §5.2).
    if (!isNewChromeEnabled()) {
      items.push({
        id: 'nav:home',
        label: 'Go to Home',
        category: 'Navigation',
        shortcut: getShortcut(shortcuts, 'go-home'),
        execute: () => setActiveProject(null),
      });
    }
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

    return items;
  }, [activeProjectId, pluginsMap, projectEnabled, shortcuts, setExplorerTab, setActiveProject, toggleHelp, openAbout]);

  const settingsItems = useMemo((): CommandItem[] =>
    SETTINGS_PAGES.map((sp) => {
      const shortcutId = sp.page === 'display' ? 'toggle-settings' : undefined;
      const shortcutDef = shortcutId ? shortcuts[shortcutId] : undefined;
      return {
        id: `settings:${sp.page}`,
        label: sp.label,
        category: 'Settings',
        keywords: ['settings', 'preferences', 'config'],
        shortcut: shortcutDef ? formatBinding(shortcutDef.currentBinding) : undefined,
        execute: () => {
          const uiState = useUIStore.getState();
          if (uiState.explorerTab !== 'settings') toggleSettings();
          setSettingsContext('app');
          setSettingsSubPage(sp.page);
        },
      };
    }),
  [shortcuts, toggleSettings, setSettingsContext, setSettingsSubPage]);

  const actionItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];

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
      execute: () => (isNewChromeEnabled() ? useChromeStore.getState().toggleSidebar() : toggleExplorerCollapse()),
    });
    // The new shell has no accessory column.
    if (!isNewChromeEnabled()) {
      items.push({
        id: 'action:toggle-accessory',
        label: 'Toggle Accessory Panel',
        category: 'Actions',
        shortcut: getShortcut(shortcuts, 'toggle-accessory'),
        execute: () => toggleAccessoryCollapse(),
      });
    }
    items.push({
      id: 'action:new-quick-agent',
      label: 'New Quick Agent',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'new-quick-agent'),
      keywords: ['agent', 'mission', 'quick'],
      execute: () => openNewQuickAgent(),
    });
    items.push({
      id: 'action:add-project',
      label: 'Add Project',
      category: 'Actions',
      shortcut: getShortcut(shortcuts, 'add-project'),
      keywords: ['new', 'open', 'folder'],
      execute: () => { useProjectStore.getState().pickAndAddProject(); },
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
          if (uiState.explorerTab !== 'settings') toggleSettings();
          setSettingsContext('app');
          setSettingsSubPage('annex');
        },
      });
    }

    items.push({
      id: 'action:agent-config',
      label: 'Agent Config',
      category: 'Actions',
      keywords: ['clubhouse', 'mode', 'durable', 'agents', 'orchestrator', 'config'],
      execute: () => {
        const uiState = useUIStore.getState();
        if (uiState.explorerTab !== 'settings') toggleSettings();
        setSettingsContext('app');
        setSettingsSubPage('orchestrators');
      },
    });

    items.push({
      id: 'action:import-blueprint',
      label: 'Import Blueprint',
      category: 'Actions',
      keywords: ['blueprint', 'canvas', 'template', 'import', 'board', 'layout'],
      execute: () => { useUIStore.getState().openBlueprintGallery(); },
    });

    items.push({
      id: 'action:export-blueprint',
      label: 'Export Canvas as Blueprint',
      category: 'Actions',
      keywords: ['blueprint', 'canvas', 'export', 'save', 'share', 'board'],
      execute: () => {
        // Export the currently active canvas as a blueprint to clipboard
        const canvasStore = activeProjectId
          ? getProjectCanvasStore(activeProjectId)
          : useAppCanvasStore;
        const { canvases, activeCanvasId } = canvasStore.getState();
        const canvas = canvases.find((c) => c.id === activeCanvasId);
        if (!canvas) return;
        // Dynamic import to avoid circular deps at module level
        import('../../plugins/builtin/canvas/canvas-blueprint').then(({ exportBlueprint }) => {
          const blueprint = exportBlueprint(canvas);
          navigator.clipboard.writeText(JSON.stringify(blueprint, null, 2)).catch(() => {});
        });
      },
    });

    if (activeProjectId) {
      items.push({
        id: 'action:export-project-blueprints',
        label: 'Export Project as Blueprint Bundle',
        category: 'Actions',
        keywords: ['blueprint', 'bundle', 'project', 'export', 'all', 'canvases', 'backup'],
        execute: () => {
          // Open project settings which has the export bundle button
          setSettingsContext('project');
        },
      });
    }

    items.push({
      id: 'action:import-blueprint-bundle',
      label: 'Import Blueprint Bundle',
      category: 'Actions',
      keywords: ['blueprint', 'bundle', 'import', 'project', 'canvases', 'restore'],
      execute: () => {
        // Open the blueprint gallery which handles both single and bundle imports
        useUIStore.getState().openBlueprintGallery();
      },
    });

    return items;
  }, [
    shortcuts, activeProjectId, annexEnabled, annexSettings, annexStatus,
    toggleSettings, toggleExplorerCollapse, toggleAccessoryCollapse,
    removeProject, setSettingsContext, setSettingsSubPage,
  ]);

  const pluginCommandItems = useMemo((): CommandItem[] =>
    pluginHotkeyRegistry.getAll().map((shortcut) => {
      const pluginEntry = pluginsMap[shortcut.pluginId];
      const pluginName = pluginEntry?.manifest.name ?? shortcut.pluginId;
      return {
        id: `plugin-cmd:${shortcut.fullCommandId}`,
        label: shortcut.title,
        category: `Plugin: ${pluginName}`,
        keywords: [shortcut.pluginId, shortcut.commandId],
        shortcut: shortcut.currentBinding ? formatBinding(shortcut.currentBinding) : undefined,
        execute: () => { pluginCommandRegistry.execute(shortcut.fullCommandId).catch(() => {}); },
      };
    }),
  [pluginsMap]);

  // Combine all category memos — only rebuilds when a sub-memo changes
  return useMemo(
    () => [...projectItems, ...agentItems, ...spaceItems, ...navigationItems, ...settingsItems, ...actionItems, ...pluginCommandItems],
    [projectItems, agentItems, spaceItems, navigationItems, settingsItems, actionItems, pluginCommandItems],
  );
}
