import { useCommandPaletteStore } from '../../stores/commandPaletteStore';
import { useAgentDetailsStore } from '../agents/details/detailsStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { usePanelStore } from '../../stores/panelStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { isNewChromeEnabled } from '../../chrome/chromeFlag';
import { FOCUS_ACTIVE_TERMINAL_EVENT } from '../agents/AgentTerminal';
import { openNewQuickAgent } from '../../chrome/startPage';
import { groupProjectAgents } from '../../chrome/sidebar/treeModel';

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
      execute: () => (isNewChromeEnabled()
        ? useChromeStore.getState().toggleSidebar()
        : usePanelStore.getState().toggleExplorerCollapse()),
    },
    {
      id: 'toggle-accessory',
      // The new chrome has no accessory column; writing the legacy panel state would
      // leave a collapsed column behind when the flag is turned off (spec §5).
      execute: () => { if (!isNewChromeEnabled()) usePanelStore.getState().toggleAccessoryCollapse(); },
    },
    {
      id: 'new-quick-agent',
      global: true,
      // The new shell opens the start page composer (spec §4.3).
      execute: () => openNewQuickAgent(),
    },
    {
      id: 'focus-active-terminal',
      // Global so it fires even when the stuck xterm helper-textarea still
      // technically holds focus — that's the exact state we need to unwedge.
      global: true,
      execute: () => window.dispatchEvent(new CustomEvent(FOCUS_ACTIVE_TERMINAL_EVENT)),
    },
    {
      id: 'toggle-agent-details',
      // Global so it works while typing in the composer.
      global: true,
      execute: () => useAgentDetailsStore.getState().toggle(),
    },
    {
      id: 'add-project',
      execute: () => useProjectStore.getState().pickAndAddProject(),
    },
    {
      id: 'close-project',
      execute: () => {
        const { activeProjectId, removeProject } = useProjectStore.getState();
        if (activeProjectId) {
          removeProject(activeProjectId);
        }
      },
    },
  ];

  // switch-agent-1..9. The new shell counts the sidebar's rows (spec §5.3):
  // awake durable agents, running quick agents, then sleeping agents.
  for (let i = 1; i <= 9; i++) {
    actions.push({
      id: `switch-agent-${i}`,
      execute: () => {
        const { agents } = useAgentStore.getState();
        const { activeProjectId } = useProjectStore.getState();
        if (!activeProjectId) return;

        const projectAgents = Object.values(agents).filter((a) => a.projectId === activeProjectId);
        let ordered: typeof projectAgents;
        if (isNewChromeEnabled()) {
          const { durable, quick, sleeping } = groupProjectAgents(projectAgents);
          ordered = [...durable, ...quick, ...sleeping];
        } else {
          // Get durable agents for the active project in order
          ordered = projectAgents.filter((a) => a.kind === 'durable');
        }

        const target = ordered[i - 1];
        if (target) {
          useUIStore.getState().setExplorerTab('agents', activeProjectId);
          useAgentStore.getState().setActiveAgent(target.id, activeProjectId);
        }
      },
    });
  }

  // tab-1..9: the new shell's title-bar tabs, in order (⌘1 is Agents).
  for (let i = 1; i <= 9; i++) {
    actions.push({
      id: `tab-${i}`,
      execute: () => {
        const { activeProjectId } = useProjectStore.getState();
        const tab = useChromeStore.getState().titleTabs[i - 1];
        if (!activeProjectId || !tab || tab.disabled) return;
        useUIStore.getState().setExplorerTab(tab.id, activeProjectId);
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
