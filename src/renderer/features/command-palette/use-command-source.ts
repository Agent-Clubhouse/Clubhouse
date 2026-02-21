import { useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useKeyboardShortcutsStore, formatBinding } from '../../stores/keyboardShortcutsStore';
import { CommandItem, SETTINGS_PAGES } from './command-registry';

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

  return useMemo(() => {
    const items: CommandItem[] = [];

    // Projects
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const shortcutDef = shortcuts[`switch-project-${i + 1}`];
      items.push({
        id: `project:${p.id}`,
        label: p.displayName || p.name,
        category: 'Projects',
        keywords: [p.name, p.path],
        detail: p.path,
        shortcut: shortcutDef ? formatBinding(shortcutDef.currentBinding) : undefined,
        execute: () => setActiveProject(p.id),
      });
    }

    // Agents
    for (const [agentId, agent] of Object.entries(agents)) {
      const project = projects.find((p) => p.id === agent.projectId);
      items.push({
        id: `agent:${agentId}`,
        label: agent.name,
        category: 'Agents',
        keywords: [project?.displayName || project?.name || ''],
        detail: project?.displayName || project?.name,
        execute: () => {
          setActiveProject(agent.projectId);
          setExplorerTab('agents', agent.projectId);
          setActiveAgent(agentId, agent.projectId);
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
      id: 'nav:help',
      label: 'Open Help',
      category: 'Navigation',
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
      shortcut: shortcuts['toggle-settings'] ? formatBinding(shortcuts['toggle-settings'].currentBinding) : undefined,
      execute: () => toggleSettings(),
    });

    items.push({
      id: 'action:add-project',
      label: 'Add Project',
      category: 'Actions',
      keywords: ['new', 'open', 'folder'],
      execute: () => {
        useProjectStore.getState().pickAndAddProject();
      },
    });

    return items;
  }, [
    projects, agents, activeProjectId, pluginsMap, projectEnabled, shortcuts,
    setActiveProject, setActiveAgent, setExplorerTab, toggleSettings,
    setSettingsSubPage, setSettingsContext, toggleHelp, openAbout,
  ]);
}
