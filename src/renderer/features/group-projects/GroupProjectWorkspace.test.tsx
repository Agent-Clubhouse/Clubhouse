import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionView } from '../../../shared/actions';
import type { GroupProject } from '../../../shared/group-project-types';
import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../stores/mcpBindingStore';
import { useProjectStore } from '../../stores/projectStore';
import { GroupProjectWorkspace } from './GroupProjectWorkspace';
import { GROUP_WORKSPACE_SECTIONS } from './groupProjectRoute';

/**
 * The workspace mounted on its own: no Canvas plugin loaded, no canvas store,
 * no canvas reference. It is what Settings and the Group Projects view mount.
 */

const dialogs = vi.hoisted(() => ({
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  approval: vi.fn<() => Promise<string>>(),
}));
vi.mock('../../plugins/PluginDialog', () => ({
  showConfirmDialog: (message: string) => ({ promise: dialogs.confirm(message) }),
  showApprovalDialog: () => ({ promise: dialogs.approval() }),
}));
const canvasLookup = vi.hoisted(() => vi.fn());
vi.mock('../agents/helpers/connection-target-navigation', () => ({
  lookupConnectionCanvases: canvasLookup,
  jumpToConnectionCanvas: vi.fn(),
}));

const GP = 'gp_ws';
const hostGroup: GroupProject = {
  id: GP, name: 'Release checks', description: 'Ship it', instructions: 'Be kind', createdAt: '2026-11-15T00:00:00Z',
  scope: { level: 'app', reach: 'local' }, metadata: {},
};
const copy: GroupProject = {
  ...hostGroup, scope: { level: 'app', reach: 'network' }, hostName: 'Studio Mac',
  network: { role: 'replica', state: 'online', waitingWrites: 0, refusals: [] },
};

function action(over: Partial<ActionView> = {}): ActionView {
  return {
    id: 'act1', name: 'Weekday summary', trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' },
    steps: [{ kind: 'group_post', topic: 'general', text: 'Summary' }], overlap: 'skip',
    owner: { kind: 'group_project', groupProjectId: GP }, enabled: true, createdAt: 1, updatedAt: 1, running: false, ...over,
  };
}

const api = () => window.clubhouse.groupProject;

function mount(props: Partial<React.ComponentProps<typeof GroupProjectWorkspace>> = {}) {
  const onBack = vi.fn();
  const onSectionChange = vi.fn();
  render(<GroupProjectWorkspace groupId={GP} onBack={onBack} onSectionChange={onSectionChange} {...props} />);
  return { onBack, onSectionChange };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  dialogs.confirm.mockReset();
  dialogs.approval.mockReset();
  canvasLookup.mockReset();
  canvasLookup.mockResolvedValue({ hits: [] });
  useGroupProjectStore.setState({ projects: [hostGroup], loaded: true, loadError: null });
  useProjectStore.setState({ projects: [] });
  useAgentStore.setState({ agents: {} });
  useMcpBindingStore.setState({ bindings: [] });
  useAnnexClientStore.setState({ satellites: [] });
  vi.spyOn(api(), 'getBulletinDigest').mockResolvedValue([
    { topic: 'general', messageCount: 1, newMessageCount: 0, latestTimestamp: '2026-11-15T10:00:00Z' },
  ]);
  vi.spyOn(api(), 'getAllMessages').mockResolvedValue([]);
  vi.spyOn(api(), 'list').mockImplementation(async () => useGroupProjectStore.getState().projects);
  (api() as unknown as Record<string, unknown>).previewDelete = vi.fn();
  window.clubhouse.actions.list = vi.fn(async () => []);
  window.clubhouse.actions.history = vi.fn(async () => []);
});

describe('GroupProjectWorkspace routing', () => {
  it('lands on Board when no section is named', async () => {
    mount();
    expect(await screen.findByTestId('group-project-section-board')).toBeInTheDocument();
    expect(await screen.findByText('general')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(GROUP_WORKSPACE_SECTIONS)('opens the %s section a link names, and no other', async (section) => {
    mount({ section });
    expect(await screen.findByTestId(`group-project-section-${section}`)).toBeInTheDocument();
    for (const other of GROUP_WORKSPACE_SECTIONS.filter((id) => id !== section)) {
      expect(screen.queryByTestId(`group-project-section-${other}`)).toBeNull();
    }
  });

  it('falls back to Board for a section it does not know', async () => {
    mount({ section: 'nonsense' as never });
    expect(await screen.findByTestId('group-project-section-board')).toBeInTheDocument();
  });

  it('follows a route that changes, and tells the opener when the person picks another section', async () => {
    const { onSectionChange } = mount({ section: 'members' });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(onSectionChange).toHaveBeenCalledWith('details');
  });

  it('names where the person came from, and Back returns there', async () => {
    const { onBack } = mount({ source: { label: 'Analyst' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Analyst' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('says Group Projects when it was opened from no particular place', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Back to Group Projects' })).toBeInTheDocument();
  });

  it('opens Permissions from the compatible Delivery route with just one migration action', async () => {
    useGroupProjectStore.setState({ projects: [{ ...hostGroup, metadata: { pollingEnabled: true, grants: { deliver: 'off' } } }] });
    const { onSectionChange } = mount({ section: 'delivery' });
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Legacy polling');
    expect(screen.queryByRole('button', { name: 'Use post notifications' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Permissions' }));
    expect(onSectionChange).toHaveBeenCalledWith('permissions');
    expect(await screen.findByLabelText('Tell members about new posts')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Use post notifications' })).toHaveLength(1);
  });

  it('names the group, what it covers, and where its host is', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Release checks' })).toBeInTheDocument();
    expect(screen.getByTestId('group-project-workspace-summary')).toHaveTextContent('App-wide. This computer. Host: This computer');
  });

  it('says so, with a way back, when the group project is not on this computer', async () => {
    const { onBack } = mount({ groupId: 'gp_gone' });
    expect(await screen.findByRole('alert')).toHaveTextContent('not on this computer');
    fireEvent.click(screen.getByRole('button', { name: /^Back to/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('starts clean when the same mounted workspace moves to another group, so a draft is never saved to it', async () => {
    useGroupProjectStore.setState({ projects: [hostGroup, { ...hostGroup, id: 'gp_other', name: 'Other', description: 'Other purpose' }] });
    const update = vi.spyOn(api(), 'update').mockResolvedValue(hostGroup);
    const onBack = vi.fn();
    const { rerender } = render(<GroupProjectWorkspace groupId={GP} section="details" onBack={onBack} />);
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Unsaved draft for the first' } });
    rerender(<GroupProjectWorkspace groupId="gp_other" section="details" onBack={onBack} />);
    expect(await screen.findByRole('heading', { name: 'Other' })).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('Other purpose');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('shows the load error with a Retry, not "not on this computer", when the list could not be read', async () => {
    useGroupProjectStore.setState({ projects: [], loaded: true, loadError: 'Registry unreadable' });
    const list = vi.spyOn(api(), 'list').mockResolvedValue([hostGroup]);
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load group projects. Registry unreadable');
    expect(screen.queryByText(/not on this computer/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Release checks' })).toBeInTheDocument();
  });

  it('shows a select for the sections when it is narrow', async () => {
    const original = globalThis.ResizeObserver;
    class Narrow {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) { this.cb([{ target, contentRect: { width: 400, height: 600 } } as ResizeObserverEntry], this as never); }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: Narrow, writable: true, configurable: true });
    try {
      mount();
      const select = await screen.findByLabelText('Section');
      expect(select).toHaveValue('board');
      expect(screen.queryByRole('navigation', { name: 'Group project sections' })).toBeNull();
      fireEvent.change(select, { target: { value: 'details' } });
      expect(await screen.findByTestId('group-project-section-details')).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { value: original, writable: true, configurable: true });
    }
  });
});

describe('GroupProjectWorkspace Details', () => {
  it('saves only the changed fields, and only when Save is pressed', async () => {
    const update = vi.spyOn(api(), 'update').mockResolvedValue({ ...hostGroup, description: 'New purpose' });
    mount({ section: 'details' });
    const description = await screen.findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'New purpose' } });
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(GP, { description: 'New purpose' }));
  });

  it('reviews who leaves before a scope change applies, with the stale-review refusal kept', async () => {
    useProjectStore.setState({ projects: [{ id: 'proj-a', name: 'Proj A', path: '/a' }] as never });
    vi.spyOn(api(), 'previewScope').mockResolvedValue({
      scope: { level: 'project', projectId: 'proj-a', reach: 'local' },
      leaving: [{ address: 'agent-b', name: 'builder-b', projectId: 'proj-b' }], returning: [],
    });
    const setScope = vi.spyOn(api(), 'setScope').mockRejectedValue(new Error('The members who would leave have changed.'));
    mount({ section: 'details' });
    const editor = await screen.findByRole('region', { name: 'Scope' });
    fireEvent.change(within(editor).getByLabelText('Covers'), { target: { value: 'project:proj-a' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review change' }));
    expect(await within(editor).findByRole('list', { name: 'Members who would leave' })).toHaveTextContent('builder-b');
    expect(setScope).not.toHaveBeenCalled();
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply and remove 1' }));
    await waitFor(() => expect(setScope).toHaveBeenCalledWith(GP, { level: 'project', projectId: 'proj-a', reach: 'local' }, { confirmLeaving: ['agent-b'] }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent('Scope not changed. The members who would leave have changed.');
  });

  it('deletes only through the impact, token and cascade dialog', async () => {
    const impact = { token: 'tok_1', members: ['Builder'], exclusions: [], canvases: [], actions: ['Weekday summary'], grants: [], messages: 3, topics: 1, machines: [], incompleteWindows: false };
    const preview = vi.mocked(api().previewDelete).mockResolvedValue(impact as never);
    const remove = vi.spyOn(api(), 'delete').mockResolvedValue(true as never);
    mount({ section: 'details' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group project' }));
    expect(await screen.findByText('Delete Release checks?')).toBeInTheDocument();
    expect(await screen.findByText(/3 messages in 1 topics/)).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith(GP);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(GP, 'tok_1'));
  });

  it('cancels a delete without calling it', async () => {
    vi.mocked(api().previewDelete).mockResolvedValue({ token: 't', members: [], exclusions: [], canvases: [], actions: [], grants: [], messages: 0, topics: 0, machines: [] } as never);
    const remove = vi.spyOn(api(), 'delete');
    mount({ section: 'details' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('disables scope change and delete on a copy, and says only the host can do them', async () => {
    useGroupProjectStore.setState({ projects: [copy] });
    mount({ section: 'details' });
    expect(await screen.findByRole('button', { name: 'Change scope' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete group project' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Scope' })).toBeNull();
    expect(screen.getAllByText(/Only Studio Mac can/)).toHaveLength(2);
    expect(screen.getAllByText(/there is no host transfer/i)).toHaveLength(2);
  });
});

describe('GroupProjectWorkspace Permissions', () => {
  beforeEach(() => {
    useMcpBindingStore.setState({
      bindings: [
        { agentId: 'a1', agentName: 'Builder', targetId: GP, targetKind: 'group-project', label: 'Release', disabledTools: ['broadcast'] },
        { agentId: 'a2', agentName: 'Analyst', targetId: GP, targetKind: 'group-project', label: 'Release' },
      ],
    });
  });

  it('keeps the default tool switches and applies them to existing members only when asked', async () => {
    const update = vi.spyOn(api(), 'update').mockResolvedValue(hostGroup);
    const setDisabled = vi.spyOn(window.clubhouse.mcpBinding, 'setDisabledTools').mockResolvedValue(undefined as never);
    dialogs.approval.mockResolvedValue('all');
    mount({ section: 'permissions' });
    fireEvent.click(await screen.findByTestId('group-project-default-permissions-button'));
    fireEvent.click(await screen.findByTestId('wire-permissions-disable-all'));
    fireEvent.click(screen.getByTestId('wire-permissions-save'));
    fireEvent.click(screen.getByTestId('group-project-save-defaults-button'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(GP, expect.objectContaining({ metadata: expect.objectContaining({ defaultDisabledTools: expect.any(Array) }) })));
    expect(update.mock.calls[0][1]).not.toHaveProperty('description');
    await waitFor(() => expect(setDisabled).toHaveBeenCalledTimes(2));
  });

  it('applies the defaults to new connections only when that is the answer', async () => {
    vi.spyOn(api(), 'update').mockResolvedValue(hostGroup);
    const setDisabled = vi.spyOn(window.clubhouse.mcpBinding, 'setDisabledTools').mockResolvedValue(undefined as never);
    dialogs.approval.mockResolvedValue('future');
    mount({ section: 'permissions' });
    fireEvent.click(await screen.findByTestId('group-project-default-permissions-button'));
    fireEvent.click(await screen.findByTestId('wire-permissions-disable-all'));
    fireEvent.click(screen.getByTestId('wire-permissions-save'));
    fireEvent.click(screen.getByTestId('group-project-save-defaults-button'));
    await waitFor(() => expect(api().update).toHaveBeenCalled());
    expect(setDisabled).not.toHaveBeenCalled();
  });

  it('saves nothing when the approval is cancelled', async () => {
    const update = vi.spyOn(api(), 'update');
    dialogs.approval.mockResolvedValue('cancel');
    mount({ section: 'permissions' });
    fireEvent.click(await screen.findByTestId('group-project-default-permissions-button'));
    fireEvent.click(await screen.findByTestId('wire-permissions-disable-all'));
    fireEvent.click(screen.getByTestId('wire-permissions-save'));
    fireEvent.click(screen.getByTestId('group-project-save-defaults-button'));
    await waitFor(() => expect(dialogs.approval).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it('edits one member\'s tools for this group project', async () => {
    const setDisabled = vi.spyOn(window.clubhouse.mcpBinding, 'setDisabledTools').mockResolvedValue(undefined as never);
    mount({ section: 'permissions' });
    const list = await screen.findByRole('list', { name: 'Member tools and instructions' });
    expect(within(list).getAllByText(/tools on/)).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Tools for Analyst' }));
    fireEvent.click(await screen.findByTestId('wire-permissions-disable-all'));
    fireEvent.click(screen.getByTestId('wire-permissions-save'));
    await waitFor(() => expect(setDisabled).toHaveBeenCalledWith('a2', GP, expect.any(Array)));
  });

  it('opens a member\'s instructions for this group project', async () => {
    mount({ section: 'permissions' });
    const list = await screen.findByRole('list', { name: 'Member tools and instructions' });
    fireEvent.click(within(list).getByRole('button', { name: 'Instructions for Builder' }));
    expect(await screen.findByTestId('connection-sources-dialog')).toBeInTheDocument();
  });

  it('lists lead and admin grants for the members', async () => {
    mount({ section: 'permissions' });
    expect(await screen.findByLabelText('Wake sleeping members')).toBeInTheDocument();
  });
});

describe('GroupProjectWorkspace Actions', () => {
  it('lists the group project\'s own Actions and edits them in place, never leaving the workspace', async () => {
    window.clubhouse.actions.list = vi.fn(async () => [action(), action({ id: 'other', name: 'Not mine', owner: { kind: 'user' } })]);
    window.clubhouse.actions.update = vi.fn(async (_id: string, input: unknown) => action({ ...(input as object) }));
    mount({ section: 'actions' });
    const list = await screen.findByRole('list', { name: 'Group project Actions' });
    expect(within(list).getByText('Weekday summary')).toBeInTheDocument();
    expect(screen.queryByText('Not mine')).toBeNull();
    fireEvent.click(within(list).getByText('Weekday summary'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = await screen.findByTestId('action-form');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Weekday digest' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(window.clubhouse.actions.update).toHaveBeenCalledWith('act1', expect.objectContaining({ name: 'Weekday digest' })));
    expect(screen.getByTestId('group-project-section-actions')).toBeInTheDocument();
  });

  it('makes a new Action owned by the group project, in place', async () => {
    window.clubhouse.actions.create = vi.fn(async (input) => action(input as never));
    mount({ section: 'actions' });
    expect(await screen.findByText('No Actions yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New action' }));
    const form = await screen.findByTestId('action-form');
    expect(within(form).getByLabelText('Owner')).toHaveValue(GP);
    fireEvent.change(within(form).getByLabelText('Runs'), { target: { value: 'event' } });
    fireEvent.change(within(form).getByLabelText('What happens'), { target: { value: 'group_project.message_posted' } });
    fireEvent.change(within(form).getByLabelText('Group project'), { target: { value: `group_project:${GP}` } });
    fireEvent.change(within(form).getByLabelText('Step 1 type'), { target: { value: 'group_post' } });
    fireEvent.change(within(form).getByLabelText('Topic'), { target: { value: 'summary' } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Digest' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(window.clubhouse.actions.create).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ kind: 'group_post', topic: 'summary', text: 'Digest' }],
    }), GP));
  });

  it('turns an Action on or off from its row', async () => {
    window.clubhouse.actions.list = vi.fn(async () => [action()]);
    window.clubhouse.actions.setEnabled = vi.fn(async () => action({ enabled: false }));
    mount({ section: 'actions' });
    fireEvent.click(await screen.findByRole('switch', { name: 'Weekday summary on or off' }));
    await waitFor(() => expect(window.clubhouse.actions.setEnabled).toHaveBeenCalledWith('act1', false));
  });

  it('is read-only on a copy: the host\'s summaries, no way to edit, and says where they run', async () => {
    useGroupProjectStore.setState({ projects: [copy] });
    useAnnexClientStore.setState({
      satellites: [{ id: 'sat', alias: 'Studio Mac', snapshot: { groupProjectActions: [
        { id: 'a', name: 'Daily board', groupProjectId: GP, groupProjectName: 'Release checks', enabled: true, description: 'Every day at 9:00 AM' },
        { id: 'b', name: 'Other group', groupProjectId: 'gp_other', groupProjectName: 'Other', enabled: true },
      ] } }] as never,
    });
    mount({ section: 'actions' });
    expect(await screen.findByText(/Runs on Studio Mac. Read-only here/)).toBeInTheDocument();
    expect(screen.getByText('Daily board')).toBeInTheDocument();
    expect(screen.getByText('Every day at 9:00 AM')).toBeInTheDocument();
    expect(screen.queryByText('Other group')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New action' })).toBeNull();
  });

  it('says unavailable, not none, when the host has shared no summary', async () => {
    useGroupProjectStore.setState({ projects: [copy] });
    mount({ section: 'actions' });
    expect(await screen.findByText(/Unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No Actions yet.')).toBeNull();
  });
});

describe('GroupProjectWorkspace other sections', () => {
  it('shows Members and Delivery', async () => {
    mount({ section: 'members' });
    expect(await screen.findByRole('heading', { name: /Members/ })).toBeInTheDocument();
  });

  it('works with no canvas at all: Canvases says so, and the Board is untouched by a canvas lookup that fails', async () => {
    canvasLookup.mockRejectedValue(new Error('Canvas is turned off'));
    mount({ section: 'canvases' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Canvas is turned off');
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(await screen.findByText('general')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument();
  });

  it('shows the Canvases section with a plain note when no canvas holds it', async () => {
    mount({ section: 'canvases' });
    expect(await screen.findByText('This group project is not on a canvas. It works without one.')).toBeInTheDocument();
  });

  it('shows the host\'s refusals in every section, and clearing them is not a retry', async () => {
    useGroupProjectStore.setState({
      projects: [{ ...copy, network: { ...copy.network!, refusals: [{ id: 'r1', groupProjectId: GP, op: 'post', reason: 'Not a member.', at: 't', author: { label: 'Analyst' } }] } }],
    });
    const dismiss = vi.spyOn(api(), 'dismissRefusals');
    mount({ section: 'members' });
    expect(await screen.findByRole('list', { name: 'Changes the host refused' })).toHaveTextContent('A post by Analyst: Not a member.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear this list' })); });
    expect(dismiss).toHaveBeenCalledWith(GP);
  });
});
