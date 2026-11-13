import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const setPolling = vi.fn(async () => {});
const update = vi.fn(async () => {});
const deleteTopic = vi.fn(async () => true);
let admins: string[] = [];
let projectAvailable = true;
let remoteProject = false;

vi.mock('./useGroupProjectContext', () => ({
  useGroupProjectContext: () => ({
    isRemote: false,
    satelliteId: null,
    project: projectAvailable ? { id: 'gp1', name: 'Launch', description: 'Ship the launch', instructions: 'Be brief', metadata: { admins } } : undefined,
    members: [
      { agentId: 'a1', agentName: 'curious-tapir' },
      { agentId: 'a2', agentName: 'bold-falcon' },
    ],
    loaded: true,
    loadProjects: vi.fn(async () => {}),
    update,
    setPolling,
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

import { GroupProjectCanvasWidget, POLLING_HINT } from './GroupProjectCanvasWidget';
import { useAgentStore } from '../../../stores/agentStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
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

  it.each([
    { mode: 'project' as const, projectId: 'p1', metadata: {}, options: { projectId: 'p1' } },
    { mode: 'app' as const, projectId: undefined, metadata: {}, options: undefined },
    { mode: 'app' as const, projectId: undefined, metadata: { projectId: 'p2' }, options: { projectId: 'p2' } },
  ])('forwards the $mode entry point context without choosing another project', async ({ mode, projectId, metadata, options }) => {
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp_new', name: 'Team' });
    renderWidget(metadata, { mode, projectId });

    await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), 'Team');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('Team', options));
  });

  it('refuses a project entry point without its current project instead of defaulting to app scope', () => {
    renderWidget({}, { mode: 'project' });
    expect(screen.getByRole('alert')).toHaveTextContent('No current project');
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });
});

describe('group project card (compact)', () => {
  it('lets a missing reference select an existing project and resolve deferred wires', async () => {
    projectAvailable = false;
    useGroupProjectStore.setState({ projects: [{ id: 'gp-existing', name: 'Shared', description: '', instructions: '', createdAt: '', metadata: {} }], loaded: true, loadError: null });
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp-missing', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    expect(screen.getByText("This group project isn't on this machine. Choose one or create one.")).toBeInTheDocument();
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
    expect(screen.queryByText(/isn't on this machine/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Existing group project')).not.toBeInTheDocument();
  });

  it('resolves a missing reference when creating its replacement', async () => {
    projectAvailable = false;
    useGroupProjectStore.setState({ projects: [], loaded: true, loadError: null });
    const create = vi.spyOn(window.clubhouse.groupProject, 'create').mockResolvedValue({ id: 'gp_new', name: 'Replacement' });
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp-missing', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), 'Replacement');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onUpdateMetadata).toHaveBeenCalledWith({ groupProjectId: 'gp_new', name: 'Replacement', __groupProjectReferenceUnresolved: false }));
    create.mockRestore();
  });

  it('resolves a retained reference once its group project is available', async () => {
    const onUpdateMetadata = vi.fn();
    render(<GroupProjectCanvasWidget widgetId="w" api={{ context: { mode: 'app' }, annex: {} } as never} metadata={{ groupProjectId: 'gp1', __groupProjectReferenceUnresolved: true }} onUpdateMetadata={onUpdateMetadata} size={{ width: 300, height: 600 }} {...({} as never)} />);
    await waitFor(() => expect(onUpdateMetadata).toHaveBeenCalledWith({ __groupProjectReferenceUnresolved: false }));
  });

  it('switches polling with the shared switch, labelled Polling', async () => {
    renderWidget();
    expect(screen.getByText('2 agents')).toBeInTheDocument();
    const polling = screen.getByRole('switch', { name: 'Polling' });
    expect(polling).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(polling);
    expect(setPolling).toHaveBeenCalledWith('gp1', true);
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

  it('makes a member a project lead from its star button', async () => {
    renderWidget();
    const falconRow = screen.getAllByTestId('group-project-member')[1];
    const star = within(falconRow).getByRole('button', { name: 'Project lead' });
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
    const stars = screen.getAllByRole('button', { name: 'Project lead' });
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

  it('toggles polling from its label too, and explains polling in a tooltip', async () => {
    renderWidget();
    const label = screen.getByText('Polling');
    expect(label.tagName).toBe('LABEL');
    // The tooltip first: the shared Tooltip stays closed after a click until the pointer leaves.
    await userEvent.hover(label);
    expect(await screen.findByText(POLLING_HINT, {}, { timeout: 2_000 })).toBeInTheDocument();
    await userEvent.click(label);
    expect(setPolling).toHaveBeenCalledWith('gp1', true);
  });

  it('opens the broadcast dialog on the shared Modal', async () => {
    renderWidget();
    await userEvent.click(screen.getByRole('button', { name: 'Broadcast message' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Broadcast message')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Include project instructions' })).toBeInTheDocument();
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

  it('keeps the polling switch in the header', () => {
    renderWidget();
    expect(screen.getByRole('switch', { name: 'Polling' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retention settings' })).toHaveAttribute('aria-pressed', 'false');
  });
});
