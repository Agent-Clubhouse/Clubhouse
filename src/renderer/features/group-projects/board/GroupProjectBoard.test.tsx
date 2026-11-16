import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulletinMessage, GroupProject, TopicDigest } from '../../../../shared/group-project-types';
import { useGroupProjectContext } from '../../../plugins/builtin/group-project/useGroupProjectContext';
import { useAgentStore } from '../../../stores/agentStore';
import { useBulletinReadStore } from '../../../stores/bulletinReadStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { GroupProjectBoard } from './GroupProjectBoard';

/**
 * The shared board on its own: no Canvas plugin, no canvas store and no canvas
 * reference anywhere in this file. Every ability the canvas card has is
 * exercised through the component the group workspace also renders.
 */

const dialogs = vi.hoisted(() => ({ confirm: vi.fn<(message: string) => Promise<boolean>>() }));
vi.mock('../../../plugins/PluginDialog', () => ({
  showConfirmDialog: (message: string) => ({ promise: dialogs.confirm(message) }),
  showApprovalDialog: vi.fn(() => ({ promise: Promise.resolve('cancel') })),
}));

const GP = 'gp_board';
const project: GroupProject = {
  id: GP, name: 'Release', description: 'Ship it', instructions: 'Be kind', createdAt: '2026-11-15T00:00:00Z',
  scope: { level: 'app', reach: 'local' }, metadata: {},
};

const topics: TopicDigest[] = [
  { topic: 'general', messageCount: 2, newMessageCount: 1, latestTimestamp: '2026-11-15T10:00:00Z' },
  { topic: 'control', messageCount: 1, newMessageCount: 0, latestTimestamp: '2026-11-15T09:00:00Z', isProtected: true },
];
const messages: BulletinMessage[] = [
  { id: 'msg_2_b', sender: 'Builder@Atlas', topic: 'general', body: 'Checks passed', timestamp: '2026-11-15T10:00:00Z' },
  { id: 'msg_1_a', sender: 'Analyst@Atlas', topic: 'general', body: 'Starting', timestamp: '2026-11-15T09:30:00Z' },
];

function Harness({ id = GP }: { id?: string }) {
  const ctx = useGroupProjectContext(id, false, null, null);
  return <GroupProjectBoard groupProjectId={id} ctx={ctx} variant="workspace" />;
}

const api = () => window.clubhouse.groupProject;

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  dialogs.confirm.mockReset();
  useBulletinReadStore.setState({ lastRead: {} });
  useGroupProjectStore.setState({ projects: [project], loaded: true, loadError: null });
  useMcpBindingStore.setState({
    bindings: [
      { agentId: 'a1', agentName: 'Builder', targetId: GP, targetKind: 'group-project', label: 'Release' },
      { agentId: 'a2', agentName: 'Analyst', targetId: GP, targetKind: 'group-project', label: 'Release' },
    ],
  });
  useAgentStore.setState({ agents: {} });
  vi.spyOn(api(), 'getBulletinDigest').mockResolvedValue(topics);
  vi.spyOn(api(), 'getAllMessages').mockResolvedValue(messages);
  vi.spyOn(api(), 'getTopicMessages').mockResolvedValue(messages);
});

async function renderBoard() {
  render(<Harness />);
  await screen.findByText('general');
}

describe('GroupProjectBoard without a canvas', () => {
  it('shows topics with unread counts and the newest message first', async () => {
    await renderBoard();
    const general = screen.getByText('general').closest('button')!;
    expect(within(general).getByTestId('group-project-topic-unread')).toHaveTextContent('1 new');
    expect(screen.getByText('control')).toBeInTheDocument();
    expect(screen.getByLabelText('Protected')).toBeInTheDocument();
    const rows = await screen.findAllByText(/Checks passed|Starting/);
    expect(rows[0]).toHaveTextContent('Checks passed');
  });

  it('opening a topic reads only that topic and clears its badge', async () => {
    await renderBoard();
    fireEvent.click(screen.getByText('general').closest('button')!);
    await waitFor(() => expect(within(screen.getByText('general').closest('button')!).queryByTestId('group-project-topic-unread')).toBeNull());
    expect(useBulletinReadStore.getState().getLastRead(GP)).toHaveProperty('general');
    expect(useBulletinReadStore.getState().getLastRead(GP)).not.toHaveProperty('control');
  });

  it('shows a message and posts a new one to the board', async () => {
    const post = vi.spyOn(api(), 'postBulletinMessage').mockResolvedValue(undefined as never);
    await renderBoard();
    fireEvent.click(await screen.findByText('Checks passed'));
    expect(screen.getAllByText('Checks passed').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Bulletin topic'), { target: { value: ' general ' } });
    fireEvent.change(screen.getByLabelText('Bulletin message'), { target: { value: ' Please review ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(GP, 'general', 'Please review'));
    await waitFor(() => expect(screen.getByLabelText('Bulletin message')).toHaveValue(''));
  });

  it('keeps what was typed and says so when a post fails', async () => {
    vi.spyOn(api(), 'postBulletinMessage').mockRejectedValue(new Error('Host refused'));
    await renderBoard();
    fireEvent.change(screen.getByLabelText('Bulletin topic'), { target: { value: 'general' } });
    fireEvent.change(screen.getByLabelText('Bulletin message'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not posted. Host refused');
    expect(screen.getByLabelText('Bulletin message')).toHaveValue('Hello');
  });

  it('broadcasts and taps through the shared injection path, with the group instructions when asked', async () => {
    const inject = vi.spyOn(api(), 'injectMessage').mockResolvedValue(true as never);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Broadcast message' }));
    const dialog = await screen.findByTestId('group-project-broadcast');
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Stand up' } });
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(inject).toHaveBeenCalledTimes(2));
    expect(inject).toHaveBeenCalledWith('a1', 'Project Instructions:\nBe kind\n\nStand up');
    expect(inject).toHaveBeenCalledWith('a2', 'Project Instructions:\nBe kind\n\nStand up');

    inject.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Broadcast message' }));
    const tap = await screen.findByTestId('group-project-broadcast');
    fireEvent.change(within(tap).getByLabelText('Send to'), { target: { value: 'a2' } });
    fireEvent.change(within(tap).getByLabelText('Message'), { target: { value: 'Just you' } });
    fireEvent.click(within(tap).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(inject).toHaveBeenCalledExactlyOnceWith('a2', 'Just you'));
  });

  it('deletes a message only after it is confirmed', async () => {
    const del = vi.spyOn(api(), 'deleteMessage').mockResolvedValue(true);
    await renderBoard();
    fireEvent.click(await screen.findByText('Starting'));
    dialogs.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0]);
    await waitFor(() => expect(dialogs.confirm).toHaveBeenCalledWith('Delete this message?'));
    expect(del).not.toHaveBeenCalled();
    dialogs.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0]);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
  });

  it('deletes a topic only after it is confirmed, and protects or unprotects it', async () => {
    const delTopic = vi.spyOn(api(), 'deleteTopic').mockResolvedValue(true);
    const protect = vi.spyOn(api(), 'setTopicProtection').mockResolvedValue(true);
    await renderBoard();
    dialogs.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete topic' })[0]);
    await waitFor(() => expect(dialogs.confirm).toHaveBeenCalledWith('Delete the "general" topic and its messages?'));
    expect(delTopic).not.toHaveBeenCalled();
    dialogs.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete topic' })[0]);
    await waitFor(() => expect(delTopic).toHaveBeenCalledWith(GP, 'general'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Protect topic' })[0]);
    await waitFor(() => expect(protect).toHaveBeenCalled());
  });

  it('clears every message only after it is confirmed', async () => {
    const clear = vi.spyOn(api(), 'clearAllMessages').mockResolvedValue({ removed: 3 });
    await renderBoard();
    dialogs.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId('group-project-clear-all'));
    await waitFor(() => expect(dialogs.confirm).toHaveBeenCalledWith('Clear every message? The description, instructions and wires stay.'));
    expect(clear).not.toHaveBeenCalled();
    dialogs.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId('group-project-clear-all'));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(GP));
    await waitFor(() => expect(screen.getByText('No topics yet')).toBeInTheDocument());
  });

  it('reviews a trim before it removes anything, then saves the limits', async () => {
    vi.spyOn(api(), 'estimateTrim').mockResolvedValue({ wouldRemove: 4 });
    const save = vi.spyOn(api(), 'saveRetentionConfig').mockResolvedValue({ saved: true, trimmed: 4 } as never);
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Retention settings' }));
    const panel = await screen.findByTestId('group-project-retention');
    expect(await within(panel).findByText('4 messages will be removed')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove and save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(GP, 100, 500));
  });

  it('toggles legacy polling through the shared setting path, and nudges every member', async () => {
    const setPolling = vi.spyOn(api(), 'setPolling').mockResolvedValue({ pollingEnabled: true, members: [] } as never);
    const inject = vi.spyOn(api(), 'injectMessage').mockResolvedValue(true as never);
    await renderBoard();
    fireEvent.click(screen.getByLabelText('Polling'));
    await waitFor(() => expect(setPolling).toHaveBeenCalledWith(GP, true));
    fireEvent.click(screen.getByRole('button', { name: 'Ask agents to start polling' }));
    await waitFor(() => expect(inject).toHaveBeenCalledTimes(2));
  });

  it('offers Resume to a member whose polling paused, with no canvas involved', async () => {
    vi.spyOn(api(), 'getPausedPolling').mockResolvedValue([{ agentId: 'a1', agentName: 'Builder' }]);
    await renderBoard();
    expect(await screen.findByText('Builder: polling paused')).toBeInTheDocument();
  });

  it('leaves renaming to the workspace and shows no Open control of its own', async () => {
    await renderBoard();
    expect(screen.queryByRole('button', { name: 'Open group project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  describe('a copy of a network group project', () => {
    const copy: GroupProject = {
      ...project, scope: { level: 'app', reach: 'network' }, hostName: 'Studio Mac',
      network: { role: 'replica', state: 'cached', waitingWrites: 1, refusals: [] },
    };

    it('says the host is offline, keeps posting open, and marks a waiting post as not on the board', async () => {
      useGroupProjectStore.setState({ projects: [copy] });
      vi.spyOn(api(), 'getAllMessages').mockResolvedValue([
        { id: 'msg_3_c', sender: 'user', topic: 'general', body: 'Please look', timestamp: 't', pending: { waitingFor: 'Studio Mac' } },
      ]);
      await renderBoard();
      expect(await screen.findByText('Waiting for Studio Mac')).toBeInTheDocument();
      expect(screen.getByText(/Studio Mac is offline. A post waits for it/)).toBeInTheDocument();
      // A post that is not on the board yet has nothing to delete.
      expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
    });

    it('disables the host-only controls with a plain reason, and refuses posting when the host left', async () => {
      useGroupProjectStore.setState({ projects: [{ ...copy, network: { ...copy.network!, state: 'host-removed' } }] });
      await renderBoard();
      expect(screen.getByTestId('group-project-clear-all')).toBeDisabled();
      expect(screen.getByTestId('group-project-copy-note')).toHaveTextContent('Posting is unavailable.');
      fireEvent.change(screen.getByLabelText('Bulletin topic'), { target: { value: 't' } });
      fireEvent.change(screen.getByLabelText('Bulletin message'), { target: { value: 'b' } });
      expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Retention settings' }));
      const panel = await screen.findByTestId('group-project-retention');
      expect(within(panel).getByText('Only Studio Mac can do this. This computer holds a copy.')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('explains which controls are the host\'s on an online copy', async () => {
      useGroupProjectStore.setState({ projects: [{ ...copy, network: { ...copy.network!, state: 'online' } }] });
      await renderBoard();
      expect(screen.getByTestId('group-project-copy-note')).toHaveTextContent('Only Studio Mac can clear all messages or change retention.');
      expect(screen.getByTestId('group-project-clear-all')).toBeDisabled();
    });
  });

  it('keeps polling for new messages while it is open', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const calls = vi.mocked(api().getBulletinDigest).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
      expect(vi.mocked(api().getBulletinDigest).mock.calls.length).toBeGreaterThan(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
