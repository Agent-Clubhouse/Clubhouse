import { useMemo, useState, useEffect, useCallback } from 'react';
import type { SettingsSubPage } from '../../../shared/types';
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
import { CATEGORY, type CommandItem } from './command-registry';
import { useSettingsCategories } from '../../panels/AccessoryPanel';
import { openNewAgentOrDialog } from '../../chrome/startPage';
import { isNewChromeEnabled } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { agentDot, groupProjectAgents } from '../../chrome/sidebar/treeModel';
import { DOT_LABEL } from '../agents/agent-status';
import { switchHost } from '../../chrome/hosts';
import { reportChromeFeature } from '../../chrome/telemetry';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';

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
  const detailed = useAgentStore((s) => s.agentDetailedStatus);
  const projectIcons = useProjectStore((s) => s.projectIcons);
  const openProjectSettings = useUIStore((s) => s.openProjectSettings);
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
  const satellites = useAnnexClientStore((s) => s.satellites);
  const satelliteProjects = useRemoteProjectStore((s) => s.satelliteProjects);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const remoteDetailed = useRemoteProjectStore((s) => s.remoteAgentDetailedStatus);
  // useSettingsCategories builds new arrays on every render; key on the content
  // so the settings rows rebuild only when the page list changes.
  const settingsCategoriesKey = JSON.stringify(useSettingsCategories());
  const settingsCategories = useMemo(
    () => JSON.parse(settingsCategoriesKey) as ReturnType<typeof useSettingsCategories>,
    [settingsCategoriesKey],
  );
  const titleTabs = useChromeStore((s) => s.titleTabs);
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
      category: CATEGORY.projects,
      keywords: [p.name, p.path],
      detail: p.id === activeProjectId ? 'Active project' : p.path,
      project: p,
      projectIconUrl: projectIcons[p.id],
      shortcut: getShortcut(shortcuts, `switch-project-${i + 1}`),
      execute: () => setActiveProject(p.id),
    }));
  }, [projects, projectIcons, activeProjectId, shortcuts, setActiveProject]);

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
      const projectName = project?.displayName || project?.name;
      const dot = agentDot(agent, detailed[agentId]);
      items.push({
        id: `agent:${agentId}`,
        label: agent.name,
        category: CATEGORY.agents,
        keywords: [projectName || ''],
        detail: projectName ? `${projectName} · ${DOT_LABEL[dot]}` : DOT_LABEL[dot],
        agent,
        dot,
        shortcut: agentShortcut,
        execute: () => {
          setActiveProject(agent.projectId);
          setExplorerTab('agents', agent.projectId);
          setActiveAgent(agentId, agent.projectId);
        },
      });
    }
    return items;
  }, [agents, detailed, projects, activeProjectId, shortcuts, setActiveProject, setExplorerTab, setActiveAgent]);

  const spaceItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const activeProjectLabel = activeProject?.displayName || activeProject?.name;

    if (canvasPluginEnabled) {
      if (activeProjectId) {
        for (const canvas of projectCanvases) {
          items.push({
            id: `canvas:project:${canvas.id}`,
            label: canvas.name,
            category: CATEGORY.canvases,
            icon: 'canvas',
            keywords: ['canvas', 'workspace', 'space', activeProjectLabel || ''],
            detail: canvas.id === projectActiveCanvasId ? `${activeProjectLabel ?? 'Project'}, open` : activeProjectLabel,
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
          category: CATEGORY.canvases,
          icon: 'canvas',
          keywords: ['canvas', 'workspace', 'space', entry.projectName],
          detail: entry.projectName,
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
        items.push({
          id: `canvas:app:${canvas.id}`,
          label: canvas.name,
          category: CATEGORY.canvases,
          icon: 'canvas',
          keywords: ['canvas', 'workspace', 'space', 'app'],
          detail: canvas.id === appActiveCanvasId && !activeProjectId ? 'App canvas, open' : 'App canvas',
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

  // The new shell's ⌘1–9 select title-bar tabs in order (spec §5.3).
  const tabShortcut = (tabId: string) => {
    if (!isNewChromeEnabled()) return undefined;
    const i = titleTabs.findIndex((t) => t.id === tabId);
    // ⌘N skips a disabled tab, so don't advertise it there.
    return i >= 0 && i < 9 && !titleTabs[i].disabled ? getShortcut(shortcuts, `tab-${i + 1}`) : undefined;
  };

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
            category: CATEGORY.commands,
            keywords: [pluginId],
            shortcut: tabShortcut(`plugin:${pluginId}`),
            execute: () => setExplorerTab(`plugin:${pluginId}`, activeProjectId),
          });
        }
      }
    }

    items.push({
      id: 'nav:agents',
      label: 'Go to Agents',
      category: CATEGORY.commands,
      shortcut: tabShortcut('agents'),
      execute: () => { if (activeProjectId) setExplorerTab('agents', activeProjectId); },
    });
    // The new shell has no Home (spec §5.2).
    if (!isNewChromeEnabled()) {
      items.push({
        id: 'nav:home',
        label: 'Go to Home',
        category: CATEGORY.commands,
        shortcut: getShortcut(shortcuts, 'go-home'),
        execute: () => setActiveProject(null),
      });
    }
    items.push({
      id: 'nav:help',
      label: 'Open help',
      category: CATEGORY.commands,
      shortcut: getShortcut(shortcuts, 'toggle-help'),
      icon: 'help',
      execute: () => toggleHelp(),
    });
    items.push({
      id: 'nav:about',
      label: 'About Clubhouse',
      category: CATEGORY.commands,
      execute: () => openAbout(),
    });

    return items;
  }, [activeProjectId, pluginsMap, projectEnabled, shortcuts, titleTabs, setExplorerTab, setActiveProject, toggleHelp, openAbout]);

  // Every page the sidebar's settings navigator lists, app and per project, so
  // the two can't drift apart. ⌘, belongs to Open settings, not to one page.
  const settingsItems = useMemo((): CommandItem[] => {
    const openApp = (page: SettingsSubPage) => {
      if (useUIStore.getState().explorerTab !== 'settings') toggleSettings();
      setSettingsContext('app');
      setSettingsSubPage(page);
    };
    const items: CommandItem[] = [{
      id: 'settings:open',
      label: 'Open settings',
      category: CATEGORY.settings,
      icon: 'settings',
      keywords: ['settings', 'preferences', 'config'],
      shortcut: getShortcut(shortcuts, 'toggle-settings'),
      execute: () => { if (useUIStore.getState().explorerTab !== 'settings') toggleSettings(); },
    }];
    for (const c of settingsCategories.app) {
      items.push({
        id: `settings:${c.page}`,
        label: c.label,
        category: CATEGORY.settings,
        icon: 'settings',
        detail: 'App',
        keywords: ['settings', 'preferences', 'config'],
        execute: () => openApp(c.page),
      });
    }
    for (const p of projects) {
      const name = p.displayName || p.name;
      for (const c of settingsCategories.project) {
        items.push({
          id: `settings:${p.id}:${c.page}`,
          label: c.label,
          category: CATEGORY.settings,
          icon: 'settings',
          detail: name,
          keywords: ['settings', 'project', name],
          searchOnly: true,
          execute: () => {
            openProjectSettings(p.id);
            setSettingsSubPage(c.page);
          },
        });
      }
    }
    return items;
  }, [settingsCategories, projects, shortcuts, toggleSettings, setSettingsContext, setSettingsSubPage, openProjectSettings]);

  const actionItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];

    items.push({
      id: 'action:toggle-sidebar',
      label: 'Toggle sidebar',
      category: CATEGORY.commands,
      shortcut: getShortcut(shortcuts, 'toggle-sidebar'),
      execute: () => (isNewChromeEnabled() ? useChromeStore.getState().toggleSidebar() : toggleExplorerCollapse()),
    });
    // The new shell has no accessory column.
    if (!isNewChromeEnabled()) {
      items.push({
        id: 'action:toggle-accessory',
        label: 'Toggle accessory panel',
        category: CATEGORY.commands,
        shortcut: getShortcut(shortcuts, 'toggle-accessory'),
        execute: () => toggleAccessoryCollapse(),
      });
    }
    // The new shell: ⌘⇧N opens the New agent page with Durable chosen (#2031).
    if (isNewChromeEnabled()) {
      items.push({
        id: 'action:new-agent',
        label: 'New agent',
        category: CATEGORY.commands,
        shortcut: getShortcut(shortcuts, 'new-quick-agent'),
        keywords: ['agent', 'durable', 'create'],
        execute: () => openNewAgentOrDialog('durable'),
      });
    }
    items.push({
      id: 'action:new-quick-agent',
      label: 'New quick agent',
      category: CATEGORY.commands,
      shortcut: isNewChromeEnabled() ? undefined : getShortcut(shortcuts, 'new-quick-agent'),
      keywords: ['agent', 'mission', 'quick'],
      execute: () => openNewAgentOrDialog('quick'),
    });
    items.push({
      id: 'action:add-project',
      label: 'Add project',
      category: CATEGORY.commands,
      shortcut: getShortcut(shortcuts, 'add-project'),
      keywords: ['new', 'open', 'folder'],
      execute: () => { useProjectStore.getState().pickAndAddProject(); },
    });

    if (activeProjectId) {
      items.push({
        id: 'action:close-project',
        label: 'Close project',
        category: CATEGORY.commands,
        shortcut: getShortcut(shortcuts, 'close-project'),
        keywords: ['remove', 'delete', 'close', 'project'],
        execute: () => removeProject(activeProjectId),
      });
    }

    if (annexEnabled) {
      items.push({
        id: 'action:toggle-annex-server',
        label: annexSettings.enableServer ? 'Disable Annex server' : 'Enable Annex server',
        category: CATEGORY.commands,
        keywords: ['annex', 'server', 'companion', 'ios', 'network', 'remote', 'control'],
        execute: () => {
          useAnnexStore.getState().saveSettings({ ...annexSettings, enableServer: !annexSettings.enableServer });
        },
      });
      items.push({
        id: 'action:toggle-annex-client',
        label: annexSettings.enableClient ? 'Disable Annex client' : 'Enable Annex client',
        category: CATEGORY.commands,
        keywords: ['annex', 'client', 'satellite', 'connect', 'network', 'discover'],
        execute: () => {
          useAnnexStore.getState().saveSettings({ ...annexSettings, enableClient: !annexSettings.enableClient });
        },
      });
      items.push({
        id: 'action:annex-show-pin',
        label: 'Show Annex PIN',
        category: CATEGORY.commands,
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
      label: 'Agent config',
      category: CATEGORY.commands,
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
      label: 'Import blueprint',
      category: CATEGORY.commands,
      keywords: ['blueprint', 'canvas', 'template', 'import', 'board', 'layout'],
      execute: () => { useUIStore.getState().openBlueprintGallery(); },
    });

    items.push({
      id: 'action:export-blueprint',
      label: 'Export canvas as blueprint',
      category: CATEGORY.commands,
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
        label: 'Export project as blueprint bundle',
        category: CATEGORY.commands,
        keywords: ['blueprint', 'bundle', 'project', 'export', 'all', 'canvases', 'backup'],
        execute: () => {
          // Open project settings which has the export bundle button
          setSettingsContext('project');
        },
      });
    }

    items.push({
      id: 'action:import-blueprint-bundle',
      label: 'Import blueprint bundle',
      category: CATEGORY.commands,
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

  // The new shell (spec §4.3): hosts, and every satellite's projects and agents.
  // Opening one on another host switches host first.
  const hostItems = useMemo((): CommandItem[] => {
    if (!isNewChromeEnabled() || satellites.length === 0) return [];
    const items: CommandItem[] = [{
      id: 'host:local',
      label: 'Switch to Local',
      category: CATEGORY.hosts,
      icon: 'host',
      execute: () => { switchHost(null); reportChromeFeature('host_switch'); },
    }];
    for (const sat of satellites) {
      items.push({
        id: `host:${sat.id}`,
        label: `Switch to ${sat.alias}`,
        category: CATEGORY.hosts,
        icon: 'host',
        detail: sat.state === 'connected' ? 'Connected' : 'Offline',
        execute: () => { switchHost(sat.id); reportChromeFeature('host_switch'); },
      });
      const projectsOnHost = satelliteProjects[sat.id] ?? [];
      const names = new Map(projectsOnHost.map((p) => [p.id, p.displayName || p.name]));
      for (const p of projectsOnHost) {
        items.push({
          id: `project:${p.id}`,
          label: p.displayName || p.name,
          category: CATEGORY.projects,
          detail: `on ${sat.alias}`,
          project: p,
          keywords: [sat.alias],
          execute: () => { switchHost(sat.id); setActiveProject(p.id); },
        });
      }
      for (const agent of Object.values(remoteAgents)) {
        const project = names.get(agent.projectId);
        if (!project) continue;
        const dot = agentDot(agent, remoteDetailed[agent.id]);
        items.push({
          id: `agent:${agent.id}`,
          label: agent.name,
          category: CATEGORY.agents,
          detail: `${project} on ${sat.alias} · ${DOT_LABEL[dot]}`,
          agent,
          dot,
          keywords: [project, sat.alias],
          execute: () => {
            switchHost(sat.id);
            setActiveProject(agent.projectId);
            setExplorerTab('agents', agent.projectId);
            setActiveAgent(agent.id, agent.projectId);
          },
        });
      }
    }
    return items;
  }, [satellites, satelliteProjects, remoteAgents, remoteDetailed, setActiveProject, setExplorerTab, setActiveAgent]);

  // Combine all category memos — only rebuilds when a sub-memo changes
  return useMemo(
    () => [...agentItems, ...projectItems, ...hostItems, ...spaceItems, ...settingsItems, ...navigationItems, ...actionItems, ...pluginCommandItems],
    [projectItems, agentItems, hostItems, spaceItems, navigationItems, settingsItems, actionItems, pluginCommandItems],
  );
}
