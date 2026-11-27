import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent } from '../../../../shared/types';

// The card is compact below 500px and the three-pane view above it.
let widgetWidth = 300;
class SizedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: widgetWidth, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: SizedResizeObserver, writable: true });

const update = vi.fn(async () => {});
const deleteTopic = vi.fn(async () => true);
let admins: string[] = [];
let projectAvailable = true;
let remoteProject = false;
let projectScope: { level: 'app'; reach: 'network' | 'local' } | undefined;
let projectHostMachine: string | null = null;

vi.mock('./useGroupProjectContext', () => ({
  useGroupProjectContext: () => ({
    isRemote: remoteProject,
    satelliteId: null,
    project: projectAvailable ? { id: 'gp1', name: 'Launch', description: 'Ship the launch', instructions: 'Be brief', metadata: { admins }, scope: projectScope, host: { machine: projectHostMachine } } : undefined,
    members: [
      { agentId: 'a1', agentName: 'curious-tapir' },
      { agentId: 'a2', agentName: 'bold-falcon' },
    ],
    loaded: true,
    loadProjects: vi.fn(async () => {}),
    update,
    // Roles are read and set where the group project lives: here, the local IPC (#3360).
    getRoles: (id: string) => window.clubhouse.groupProject.getRoles(id),
    setRole: (id: string, agentId: string, role: 'lead' | 'admin', mode: 'allow' | 'ask' | 'off') => window.clubhouse.groupProject.setRole(id, agentId, role, mode),
    fetchDigest: vi.fn(async () => [{ topic: 'general', messageCount: 3, newMessageCount: 1, latestTimestamp: '2026-10-18T10:00:00.000Z' }]),
    fetchTopicMessages: vi.fn(async () => []),
    fetchAllMessages: vi.fn(async () => []),
    injectMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => true),
    deleteTopic,
    setTopicProtection: vi.fn(async () => true),
    clearAllMessages: vi.fn(async () => ({ removed: 0 })),
    estimateTrim: vi.fn(async () => ({ wouldRemove: 0 })),
  }),
}));

vi.mock('../../../hooks/useRemoteProject', () => ({
  useRemoteProject: () => ({ isRemote: remoteProject, satelliteId: remoteProject ? 'satellite' : null }),
}));

let confirmAnswer = true;
const showConfirmDialog = vi.fn((_message: string) => ({ promise: Promise.resolve(confirmAnswer), cleanup: () => {} }));
vi.mock('../../PluginDialog', () => ({
  showConfirmDialog: (message: string) => showConfirmDialog(message),
  showApprovalDialog: () => ({ promise: Promise.resolve(null), cleanup: () => {} }),
}));

import { GroupProjectCanvasWidget } from './GroupProjectCanvasWidget';
import { useAgentStore } from '../../../stores/agentStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useAnnexStore } from '../../../stores/annexStore';
import { useUIStore } from '../../../stores/uiStore';
import { useGroupProjectsNavStore } from '../../../features/group-projects/groupProjectsNavStore';
import { useGroupWorkspaceBack } from '../../../features/group-projects/groupWorkspaceSource';
import { DOT_LABEL, type AgentDot } from '../../../features/agents/agent-status';

const tapir: Agent = { id: 'a1', projectId: 'p1', name: 'curious-tapir', kind: 'durable', status: 'running', color: 'teal' };

function renderWidget(
  metadata: Record<string, unknown> = { groupProjectId: 'gp1' },
  context: { mode: 'app' | 'project'; projectId?: string } = { mode: 'app' },
) {
  return render(
    <GroupProjectCanvasWidget
      widgetId="w1"
      api={{ context, annex: {} } as never}
      metadata={metadata}
      onUpdateMetadata={vi.fn()}
      size={{ width: widgetWidth, height: 600 }}
      {...({} as never)}
    />,
  );
}

/** Leads hold the lead grant (#3360), read over IPC. */
function rolesFor(leads: string[]) {
  return { groupProjectId: 'gp1', own: { deliver: 'allow' as const, wake: 'off' as const, actions: 'allow' as const }, holders: leads.map((agentId) => ({ agentId, lead: 'allow' as const, admin: 'off' as const })) };
}

beforeEach(() => {
  widgetWidth = 300;
  admins = [];
  projectAvailable = true;
  remoteProject = false;
  vi.spyOn(window.clubhouse.groupProject, 'getRoles').mockImplementation(async () => rolesFor(admins));
  projectScope = undefined;
  projectHostMachine = null;
  useAnnexStore.setState((state) => ({ status: { ...state.status, fingerprint: 'local-fingerprint' } }));
  confirmAnswer = true;
  vi.clearAllMocks();
  useAgentStore.setState({ agents: { a1: tapir }, agentDetailedStatus: {} } as never);
});

describe('group project creation context', () => {
  beforeEach(() => {
    useGroupProjectStore.setState({ projects: [], loaded: true, loadError: null });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('places an existing group project without creating another record', async () => {
    useGroupProjectStore.setState({ projects: [{ id: 'gp-existing', name: 'Shared', description: '', instructions: '', createdAt: '', metadata: {} }] });
    const onUpdateMetadata = vi.fn();
    const create = vi.spyOn(window.clubhouse.groupProject, 'create');
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{}} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    await userEvent.selectOptions(screen.getByLabelText('Existing group project'), 'gp-existing');
    await userEvent.click(screen.getByRole('button', { name: 'Add existing' }));
    expect(onUpdateMetadata).toHaveBeenCalledWith({ groupProjectId: 'gp-existing', name: 'Shared' });
    expect(create).not.toHaveBeenCalled();
  });

  it('filters the picker by scope without restricting cross-canvas placement', async () => {
    useGroupProjectStore.setState({ projects: [
      { id: 'app-gp', name: 'App project', description: '', instructions: '', createdAt: '', metadata: {}, scope: { level: 'app', reach: 'local' } },
      { id: 'project-gp', name: 'Project group', description: '', instructions: '', createdAt: '', metadata: {}, scope: { level: 'project', projectId: 'other', reach: 'local' } },
    ] });
    renderWidget({}, { mode: 'project', projectId: 'p1' });
    expect(screen.getByRole('option', { name: 'Project group' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'app');
    expect(screen.getByRole('option', { name: 'App project' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Project group' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'all');
    expect(screen.getByRole('option', { name: 'Project group' })).toBeInTheDocument();
  });

  it.each([
    { mode: 'project' as const, projectId: 'p1', metadata: {}, options: { projectId: 'p1' } },
    { mode: 'app' as const, projectId: undefined, metadata: {}, options: undefined },
    { mode: 'app' as const, projectId: undefined, metadata: { projectId: 'p2' }, options: { projectId: 'p2' } },
  ])('forwards the $mode entry point context without choosing another project', async ({ mode, projectId, metadata, options }) => {
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp_new', name: 'Team' });
    renderWidget(metadata, { mode, projectId });

    await userEvent.type(screen.getByRole('textbox', { name: 'Group project name' }), 'Team');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('Team', options));
  });

  it('refuses a project entry point without its current project instead of defaulting to app scope', () => {
    renderWidget({}, { mode: 'project' });
    expect(screen.getByRole('alert')).toHaveTextContent('No current project');
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });
});

describe('post notification tooltip keyboard access (#3668)', () => {
  it.each([300, 600])('makes the full status explanation reachable by Tab at width %i', async (width) => {
    widgetWidth = width;
    renderWidget();
    const status = screen.getByRole('status', { name: 'Post notifications' });
    const user = userEvent.setup();

    // The label is truncated at narrow widths. A keyboard user must be able
    // to reach its tooltip, including the saved-configuration limitation.
    for (let i = 0; i < 30 && document.activeElement !== status; i++) {
      await user.tab();
    }
    expect(status).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Saved configuration, not confirmation that messages reached members on other computers.');
  });
});

describe('group project card (compact)', () => {
  it('shows this computer for a matching network host fingerprint', () => {
    projectScope = { level: 'app', reach: 'network' };
    projectHostMachine = 'LOCAL-FINGERPRINT';
    renderWidget();
    expect(screen.getByTestId('group-project-scope')).toHaveTextContent('App / Network · Host: This computer');
  });

  it('shows the other host fingerprint for a network project', () => {
    projectScope = { level: 'app', reach: 'network' };
    projectHostMachine = 'other-fingerprint';
    renderWidget();
    expect(screen.getByTestId('group-project-scope')).toHaveTextContent('App / Network · Host: other-fingerprint');
  });
  it('lets a missing reference select an existing project and resolve deferred wires', async () => {
    projectAvailable = false;
    useGroupProjectStore.setState({ projects: [{ id: 'gp-existing', name: 'Shared', description: '', instructions: '', createdAt: '', metadata: {} }], loaded: true, loadError: null });
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp-missing', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    expect(screen.getByText("This group project isn't on this computer. Choose one or create one.")).toBeInTheDocument();
    expect(screen.queryByText(/gp-missing/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Existing group project'), 'gp-existing');
    await userEvent.click(screen.getByRole('button', { name: 'Add existing' }));
    expect(onUpdateMetadata).toHaveBeenCalledWith({ groupProjectId: 'gp-existing', name: 'Shared', __groupProjectReferenceUnresolved: false });
  });

  it('does not offer local replacement while a remote snapshot is pending', () => {
    projectAvailable = false;
    remoteProject = true;
    renderWidget({ groupProjectId: 'gp-missing' }, { mode: 'project', projectId: 'remote-project' });
    expect(screen.queryByText(/isn't on this computer/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Existing group project')).not.toBeInTheDocument();
  });

  it('resolves a missing reference when creating its replacement', async () => {
    projectAvailable = false;
    useGroupProjectStore.setState({ projects: [], loaded: true, loadError: null });
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp_new', name: 'Replacement' });
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp-missing', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Group project name' }), 'Replacement');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onUpdateMetadata).toHaveBeenCalledWith({ groupProjectId: 'gp_new', name: 'Replacement', __groupProjectReferenceUnresolved: false }));
    create.mockRestore();
  });

  it('resolves a retained reference once its group project is available', async () => {
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp1', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    await waitFor(() => expect(onUpdateMetadata).toHaveBeenCalledWith({ __groupProjectReferenceUnresolved: false }));
  });

  it('shows post notification configuration without a reversible polling control', () => {
    renderWidget();
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: On');
    expect(screen.queryByRole('switch', { name: 'Polling' })).not.toBeInTheDocument();
  });

  it('lists members with an avatar row, the lead word and a status dot plus one word', async () => {
    admins = ['a1'];
    renderWidget();
    const rows = screen.getAllByTestId('group-project-member');
    expect(rows).toHaveLength(2);
    const tapirRow = rows[0];
    expect(await within(tapirRow).findByText('Lead')).toBeInTheDocument();
    const dot = tapirRow.querySelector('[data-dot]')!;
    expect(within(tapirRow).getByText(DOT_LABEL[dot.getAttribute('data-dot') as AgentDot])).toBeInTheDocument();
    // An agent this window doesn't have (e.g. remote) shows no status rather than a guess.
    expect(rows[1].querySelector('[data-dot]')).toBeNull();
  });

  it('makes a member a lead from its star button', async () => {
    renderWidget();
    const falconRow = screen.getAllByTestId('group-project-member')[1];
    const star = within(falconRow).getByRole('button', { name: 'Lead' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    const setRole = vi.spyOn(window.clubhouse.groupProject, 'setRole').mockResolvedValue(rolesFor(['a2']));
    await userEvent.click(star);
    // The lead grant on this group project, not a role in its metadata (#3360).
    expect(setRole).toHaveBeenCalledWith('gp1', 'a2', 'lead', 'allow');
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(star).toHaveAttribute('aria-pressed', 'true'));
  });

  it('keeps the star button\'s name fixed and says lead or not with aria-pressed', async () => {
    admins = ['a1'];
    renderWidget();
    const stars = screen.getAllByRole('button', { name: 'Lead' });
    await waitFor(() => expect(stars.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']));
  });

  it('reads a member\'s status once: the word, not also the dot', () => {
    renderWidget();
    const row = screen.getAllByTestId('group-project-member')[0];
    const dot = row.querySelector('[data-dot]')!;
    const word = DOT_LABEL[dot.getAttribute('data-dot') as AgentDot];
    expect(dot.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(row).queryByRole('img', { name: word })).toBeNull();
    expect(within(row).getByText(word)).toBeInTheDocument();
  });

});

describe('group project card (expanded)', () => {
  beforeEach(() => { widgetWidth = 900; });

  it('asks through the shared confirm dialog before deleting a topic', async () => {
    renderWidget();
    await screen.findByText('general');
    expect(screen.getByTestId('group-project-topic-unread')).toHaveTextContent('1 new');
    confirmAnswer = false;
    await userEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    expect(deleteTopic).not.toHaveBeenCalled();
    confirmAnswer = true;
    await userEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    await waitFor(() => expect(deleteTopic).toHaveBeenCalledWith('gp1', 'general'));
  });

  it('keeps the protect button\'s name fixed, with aria-pressed for its state', async () => {
    renderWidget();
    await screen.findByText('general');
    const protect = screen.getByRole('button', { name: 'Protect topic' });
    expect(protect).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the post notification state in the header', () => {
    renderWidget();
    expect(screen.getByRole('status', { name: 'Post notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retention settings' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Open group project from the canvas card (#3545)', () => {
  beforeEach(() => {
    useGroupProjectsNavStore.setState({ route: null });
    useUIStore.setState({ explorerTab: 'plugin:canvas', dispatcherOpen: false });
  });

  it.each([300, 900])('opens the workspace on its Board and names the canvas as the way back, at %ipx', async (width) => {
    widgetWidth = width;
    renderWidget();
    await userEvent.click(await screen.findByRole('button', { name: 'Open group project' }));
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp1' });
    const { result } = renderHook(() => useGroupWorkspaceBack());
    expect(result.current.source?.label).toBe('Canvas');
    act(() => result.current.back());
    expect(useUIStore.getState().explorerTab).toBe('plugin:canvas');
    expect(useGroupProjectsNavStore.getState().route).toBeNull();
  });

  it('is not offered on a card showing another computer\'s group project', async () => {
    remoteProject = true;
    renderWidget({ groupProjectId: 'gp1', projectId: 'remote||sat||p1' });
    await screen.findByRole('status', { name: 'Post notifications' });
    expect(screen.queryByRole('button', { name: 'Open group project' })).toBeNull();
  });

  it('is not offered in a popout, which has no main-window route to hand off to', async () => {
    const popout = vi.spyOn(window.clubhouse.window, 'isPopout').mockReturnValue(true);
    renderWidget();
    await screen.findByRole('status', { name: 'Post notifications' });
    expect(screen.queryByRole('button', { name: 'Open group project' })).toBeNull();
    popout.mockRestore();
  });
});
