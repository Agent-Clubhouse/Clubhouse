/**
 * Actions in the renderer (#2953): the list from main, kept fresh by its
 * change broadcast, and names for agents and projects from the stores.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { ActionInput, ActionNames, ActionOwner, ActionView } from '../../../shared/actions';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { closeDispatcher } from '../dispatcher/dispatcherNav';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { useAnnexStore } from '../../stores/annexStore';

export function useActionsList(): { actions: ActionView[] | null; error: string | null; reload: () => void } {
  const [actions, setActions] = useState<ActionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    window.clubhouse.actions.list().then((list) => {
      setActions(list);
      setError(null);
    }).catch((err: unknown) => {
      // telemetry-exempt: shown on the page, which offers a retry
      setError(ipcErrorMessage(err));
    });
  }, []);
  useEffect(() => {
    reload();
    return window.clubhouse.actions.onChanged(reload);
  }, [reload]);
  return { actions, error, reload };
}

export interface AgentOption {
  id: string;
  name: string;
  projectId: string;
  worktreePath?: string;
  parentAgentId?: string;
  quick?: boolean;
}

export interface ProjectOption {
  id: string;
  name: string;
}

/** Agents and projects for trigger pickers and plain-words lines. */
export function useActionNames(): { names: ActionNames; agents: AgentOption[]; projects: ProjectOption[] } {
  const agentMap = useAgentStore((s) => s.agents);
  const projectList = useProjectStore((s) => s.projects);
  const devices = useAnnexStore((s) => s.devices);
  // The Dispatcher by the name the user gave it (#3184).
  const dispatcherName = useDispatcherStore((s) => s.state?.config?.name?.trim() || undefined);
  return useMemo(() => {
    const projects: ProjectOption[] = projectList.map((p) => ({ id: p.id, name: p.displayName || p.name }));
    const agents: AgentOption[] = Object.values(agentMap)
      .filter((a) => a.kind === 'durable' || a.kind === 'quick')
      .map((a) => ({
        id: a.id, name: a.name, projectId: a.projectId,
        ...(a.worktreePath && { worktreePath: a.worktreePath }),
        ...(a.parentAgentId && { parentAgentId: a.parentAgentId }),
        ...(a.kind === 'quick' && { quick: true }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const agentNames = new Map(agents.map((a) => [a.id, a.name]));
    return {
      names: {
        agent: (id) => agentNames.get(id), project: (id) => projectNames.get(id), dispatcher: () => dispatcherName,
        device: (id) => devices.find((d) => d.fingerprint.toLowerCase() === id.toLowerCase())?.alias || undefined,
      },
      agents,
      projects,
    };
  }, [agentMap, projectList, dispatcherName, devices]);
}

/** "You", the Dispatcher's name, or the agent's name. */
export function ownerLabel(owner: ActionOwner, names: ActionNames): string {
  if (owner.kind === 'user') return 'You';
  if (owner.kind === 'dispatcher') return names.dispatcher?.() || 'Dispatcher';
  if (owner.kind === 'agent') return names.agent(owner.agentId) ?? 'An agent';
  return 'Clubhouse';
}

/** The project an action belongs with in the list: its trigger's, else its first step's. */
export function actionProjectId(a: Pick<ActionView, 'trigger' | 'steps'>, agentProject: (agentId: string) => string | undefined): string | undefined {
  const t = a.trigger;
  if (t.kind === 'event') {
    if (t.source.kind === 'project') return t.source.projectId;
    if (t.source.kind === 'agent') return agentProject(t.source.agentId);
  }
  for (const s of a.steps) {
    if (s.kind === 'quick') return s.projectId;
    if ('agentId' in s) {
      const p = agentProject(s.agentId);
      if (p) return p;
    }
  }
  return undefined;
}

// ── Opening the page and the form from elsewhere ────────────────────────────

interface ActionsNavState {
  /** A form to open when the page shows: a new action pre-filled, or an action to edit. */
  pending: { draft?: Partial<ActionInput>; editId?: string; cardId?: string } | null;
  setPending: (p: ActionsNavState['pending']) => void;
}

export const useActionsNav = create<ActionsNavState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));

/** Settings > Actions, optionally opening a pre-filled form or an action's card. */
export function openActionsSettings(pending?: ActionsNavState['pending']): void {
  if (pending) useActionsNav.getState().setPending(pending);
  closeDispatcher();
  const ui = useUIStore.getState();
  ui.setSettingsContext('app');
  ui.setSettingsSubPage('actions');
  if (ui.explorerTab !== 'settings') ui.toggleSettings();
}
