import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { usePanelStore } from '../../stores/panelStore';

export interface CommandAction {
  id: string;
  execute: () => void;
  /** When true, fires even when focus is in a text input (e.g., command-palette toggle) */
  global?: boolean;
}

export function getCommandActions(): CommandAction[] {
  const actions: CommandAction[] = [
    {
      id: 'command-palette',
      global: true,
      execute: () => useCommandPaletteStore.getState().toggle(),
    },
    {
      id: 'toggle-settings',
      execute: () => useUIStore.getState().toggleSettings(),
    },
    {
      id: 'toggle-help',
      execute: () => useUIStore.getState().toggleHelp(),
    },
    {
      id: 'go-home',
      execute: () => useProjectStore.getState().setActiveProject(null),
    },
    {
      id: 'toggle-sidebar',
      execute: () => usePanelStore.getState().toggleExplorerCollapse(),
    },
    {
      id: 'toggle-accessory',
      execute: () => usePanelStore.getState().toggleAccessoryCollapse(),
    },
    {
      id: 'new-quick-agent',
      execute: () => {
        useUIStore.getState().openQuickAgentDialog();
      },
    },
    {
      id: 'add-project',
      execute: () => useProjectStore.getState().pickAndAddProject(),
    },
  ];

  // switch-agent-1..9
  for (let i = 1; i <= 9; i++) {
    actions.push({
      id: `switch-agent-${i}`,
      execute: () => {
        const { agents } = useAgentStore.getState();
        const { activeProjectId } = useProjectStore.getState();
        if (!activeProjectId) return;

        // Get durable agents for the active project in order
        const durableAgents = Object.values(agents)
          .filter((a) => a.projectId === activeProjectId && a.kind === 'durable');

        const target = durableAgents[i - 1];
        if (target) {
          useUIStore.getState().setExplorerTab('agents', activeProjectId);
          useAgentStore.getState().setActiveAgent(target.id, activeProjectId);
        }
      },
    });
  }

  // switch-project-1..9
  for (let i = 1; i <= 9; i++) {
    actions.push({
      id: `switch-project-${i}`,
      execute: () => {
        const { projects, setActiveProject } = useProjectStore.getState();
        const target = projects[i - 1];
        if (target) {
          setActiveProject(target.id);
        }
      },
    });
  }

  return actions;
}
