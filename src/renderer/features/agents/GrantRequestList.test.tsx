import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GrantRequest } from '../../../shared/grant-requests';
import { describeGrantRequests, useGrantRequestStore } from '../../stores/grantRequestStore';
import { GrantRequestList } from './GrantRequestList';
import { GrantRequestDialog } from './GrantRequestDialog';

const request = (r: Partial<GrantRequest> = {}): GrantRequest => ({
  requestId: 'g1', kind: 'grant', agentId: 'a1', agentName: 'Ada', projectPath: '/p',
  actions: ['settings.app.write'], where: 'the app', target: { kind: 'app' }, reason: 'To pick a cheaper model.',
  createdAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(), ...r,
});

beforeEach(() => {
  useGrantRequestStore.setState({ requests: {}, reviewing: null });
  window.clubhouse.agent.answerGrantRequest = vi.fn(async () => ({ ok: true as const }));
});

describe('permission requests (#2970)', () => {
  it('says what is asked, why, and what Allow does', () => {
    useGrantRequestStore.getState().add(request());
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    expect(screen.getByText('Asks for Change app settings on the app.')).toBeInTheDocument();
    expect(screen.getByText('Its reason: To pick a cheaper model.')).toBeInTheDocument();
    expect(screen.getByText(/adds this to its Clubhouse permissions/)).toBeInTheDocument();
  });

  it('a call request shows the call and says Allow is one time', () => {
    useGrantRequestStore.getState().add(request({ kind: 'call', toolName: 'set_helper_presets', details: '{ "reset": {} }', reason: undefined, target: undefined }));
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    expect(screen.getByText(/Wants to run set_helper_presets/)).toBeInTheDocument();
    expect(screen.getByText('{ "reset": {} }')).toBeInTheDocument();
    expect(screen.getByText(/runs this one call/)).toBeInTheDocument();
  });

  it('Allow sends the answer and the request leaves', async () => {
    useGrantRequestStore.getState().add(request());
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    fireEvent.click(screen.getByTestId('grant-request-allow'));
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledWith('g1', true));
    await waitFor(() => expect(screen.queryByTestId('grant-request-list')).not.toBeInTheDocument());
  });

  it('a failed answer stays, with the reason', async () => {
    window.clubhouse.agent.answerGrantRequest = vi.fn(async () => ({ ok: false as const, error: 'Agent not found' }));
    useGrantRequestStore.getState().add(request());
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    fireEvent.click(screen.getByTestId('grant-request-decline'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent not found');
    expect(screen.getByTestId('grant-request-g1')).toBeInTheDocument();
  });

  it('the review dialog opens for the agent and closes when nothing is left', async () => {
    useGrantRequestStore.getState().add(request());
    render(<GrantRequestDialog />);
    expect(screen.queryByTestId('grant-request-dialog')).not.toBeInTheDocument();
    useGrantRequestStore.getState().review('a1');
    expect(await screen.findByText('Ada is asking')).toBeInTheDocument();
    useGrantRequestStore.getState().remove(['g1']);
    await waitFor(() => expect(screen.queryByText('Ada is asking')).not.toBeInTheDocument());
    expect(useGrantRequestStore.getState().reviewing).toBeNull();
  });

  it('describes an agent\'s requests for Needs you', () => {
    expect(describeGrantRequests([request()])).toBe('Change app settings');
    expect(describeGrantRequests([request({ kind: 'call', actions: ['project.add'] })])).toBe('Add or open projects');
    expect(describeGrantRequests([request(), request({ requestId: 'g2' })])).toBe('Change app settings (2 requests)');
  });

  it('shows an update and its interruption list with explicit restart choices, never a generic Allow', async () => {
    const update = request({ kind: 'call', actions: ['app.update'], update: { version: '1.1.0', workingAgents: [{ agentId: 'builder', name: 'Builder' }] },
      details: 'Working agents that Restart now would interrupt: Builder (builder).' });
    useGrantRequestStore.getState().add(update);
    expect(describeGrantRequests([update])).toBe('Update Clubhouse to 1.1.0');
    expect(describeGrantRequests([request({ requestId: 'earlier' }), update])).toBe('Update Clubhouse to 1.1.0 (2 requests)');
    render(<GrantRequestList agentId="a1" agentName="Dispatcher" />);
    expect(screen.getByText('Update Clubhouse to 1.1.0')).toBeInTheDocument();
    expect(screen.getByText(/Working agents.*Builder/)).toBeInTheDocument();
    expect(screen.queryByTestId('grant-request-allow')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart when idle' }));
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledWith('g1', true, 'when_idle'));
  });
});

it('shows one review with exact deletion consequences, work at risk, force, helpers and refusals', () => {
  useGrantRequestStore.getState().add(request({ kind: 'call', toolName: 'delete_agents', deleteReview: { items: [{
    index: 0, requestedProject: 'Project', requestedAgent: 'One', status: 'ready', worktree: 'delete', helpers: 'dispose', force: true,
    target: { project: '/project', agentId: 'exact-one', name: 'One', worktreePath: '/work/one', branch: 'one/standby', work: {
      isValid: true, branch: 'one/standby', hasRemote: true, uncommittedFiles: [{ path: 'unsaved.ts', status: 'M', staged: false }],
      unpushedCommits: [{ hash: '123', shortHash: '123', subject: 'Unpushed work', author: 'Test', date: '' }],
    } }, helperTargets: [{ project: '/other', agentId: 'helper-id', name: 'Helper' }],
  }, { index: 1, requestedProject: 'Project', requestedAgent: 'Missing', status: 'refused', reason: 'No exact target.', worktree: 'keep', helpers: 'keep', force: false, helperTargets: [] }] } }));
  render(<GrantRequestList agentId="a1" agentName="Ada" />);
  expect(screen.getAllByTestId('grant-request-allow')).toHaveLength(1);
  expect(screen.getByText('Review deleting 1 agent together.')).toBeInTheDocument();
  expect(screen.getByText(/One \(exact-one\) in \/project/)).toBeInTheDocument();
  expect(screen.getByText(/Remove \/work\/one.*Remove branch one\/standby/)).toBeInTheDocument();
  expect(screen.getByText(/1 uncommitted file and 1 unpushed commit at risk when removed/)).toBeInTheDocument();
  expect(screen.getByText(/Force is explicitly enabled/)).toBeInTheDocument();
  expect(screen.getByText('unsaved.ts (M)')).toBeInTheDocument();
  expect(screen.getByText('123 Unpushed work')).toBeInTheDocument();
  expect(screen.getByText(/Helper \(helper-id\) in \/other/)).toBeInTheDocument();
  expect(screen.getByText(/Refused Missing/)).toBeInTheDocument();
  expect(screen.getByText('No exact target.')).toBeInTheDocument();
});

it('shows refused row reasons without removal, force or helper consequences', () => {
  useGrantRequestStore.getState().add(request({ kind: 'call', toolName: 'delete_agents', deleteReview: { items: [{
    index: 0, requestedProject: 'Project', requestedAgent: 'Refused target', status: 'refused', reason: 'Work could not be checked.',
    worktree: 'delete', helpers: 'dispose', force: true,
    target: { project: '/project', agentId: 'refused-id', name: 'Refused target', worktreePath: '/never-remove', branch: 'never-remove' },
    helperTargets: [{ project: '/other', agentId: 'helper-id', name: 'Never dispose' }],
  }] } }));
  render(<GrantRequestList agentId="a1" agentName="Ada" />);
  expect(screen.getByText('Work could not be checked.')).toBeInTheDocument();
  expect(screen.queryByText(/Remove \/never-remove/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Force is explicitly enabled/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Never dispose/)).not.toBeInTheDocument();
  expect(screen.getByText(/Ignored files and work inside untracked nested repositories are not checked/)).toBeInTheDocument();
});

describe('a queue of permission requests answers the one acted on (#3606)', () => {
  const first = () => request({ requestId: 'g1', reason: 'Short.' });
  const second = () => request({
    requestId: 'g2', createdAt: new Date(5).toISOString(), kind: 'call', toolName: 'set_helper_presets',
    details: '{ "reset": {}, "presets": [1, 2, 3] }', reason: 'A much longer reason, so this row is taller than the one before it.', target: undefined,
  });
  const row = (id: string) => screen.getByTestId(`grant-request-${id}`);
  const seed = () => {
    useGrantRequestStore.getState().add(first());
    useGrantRequestStore.getState().add(second());
  };

  it('a click aimed at the head request does not answer the one that takes its place', async () => {
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    const oldAllow = within(row('g1')).getByTestId('grant-request-allow');
    fireEvent.click(oldAllow);
    await waitFor(() => expect(screen.queryByTestId('grant-request-g1')).not.toBeInTheDocument());
    expect(within(row('g2')).getByTestId('grant-request-allow')).toBeEnabled();
    fireEvent.click(oldAllow);
    expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row('g2')).getByTestId('grant-request-decline'));
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenLastCalledWith('g2', false));
    expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledTimes(2);
  });

  it('a double click answers at most one request: the second press is not a click on the next row', async () => {
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    fireEvent.click(within(row('g1')).getByTestId('grant-request-allow'), { detail: 1 });
    await waitFor(() => expect(screen.queryByTestId('grant-request-g1')).not.toBeInTheDocument());
    fireEvent.click(within(row('g2')).getByTestId('grant-request-allow'), { detail: 2 });
    expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledExactlyOnceWith('g1', true);
    fireEvent.click(within(row('g2')).getByTestId('grant-request-allow'), { detail: 1 });
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenLastCalledWith('g2', true));
  });

  it('refuses an answer for a request that closed, before the list has redrawn', () => {
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    const stale = within(row('g1')).getByTestId('grant-request-allow');
    // Main closed it (answered elsewhere or expired); the old button is still on screen until React redraws.
    useGrantRequestStore.getState().remove(['g1']);
    fireEvent.click(stale);
    expect(window.clubhouse.agent.answerGrantRequest).not.toHaveBeenCalled();
  });

  it('sends one answer per activation, even for two presses in the same tick', async () => {
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    const button = within(row('g1')).getByTestId('grant-request-allow');
    act(() => { button.click(); button.click(); });
    await waitFor(() => expect(screen.queryByTestId('grant-request-g1')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledExactlyOnceWith('g1', true);
  });

  it('a failed answer shows its error on its own row, and the retry answers the same request', async () => {
    window.clubhouse.agent.answerGrantRequest = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: 'Agent not found' })
      .mockResolvedValue({ ok: true as const });
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    const user = userEvent.setup();
    within(row('g1')).getByTestId('grant-request-allow').focus();
    await user.keyboard('{Enter}');
    expect(await within(row('g1')).findByRole('alert')).toHaveTextContent('Agent not found');
    expect(within(row('g2')).queryByRole('alert')).toBeNull();
    await waitFor(() => expect(within(row('g1')).getByTestId('grant-request-allow')).toBeEnabled());
    await user.click(within(row('g1')).getByTestId('grant-request-allow'));
    await waitFor(() => expect(screen.queryByTestId('grant-request-g1')).not.toBeInTheDocument());
    expect(vi.mocked(window.clubhouse.agent.answerGrantRequest).mock.calls).toEqual([['g1', true], ['g1', true]]);
  });

  it('keyboard activation answers only the focused row', async () => {
    seed();
    render(<GrantRequestList agentId="a1" agentName="Ada" />);
    const user = userEvent.setup();
    within(row('g2')).getByTestId('grant-request-decline').focus();
    await user.keyboard(' ');
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledExactlyOnceWith('g2', false));
  });
});

describe('the review dialog keeps its answers in one place (#3606)', () => {
  const asks = (id: string, createdAt: number, reason: string) => request({ requestId: id, createdAt: new Date(createdAt).toISOString(), reason });

  it('shows the oldest request, with its answers in a footer of a panel of fixed size', async () => {
    useGrantRequestStore.getState().add(asks('g1', 0, 'Short.'));
    useGrantRequestStore.getState().add(asks('g2', 5, 'A much longer reason, so the next request is taller than this one.'.repeat(4)));
    useGrantRequestStore.getState().review('a1');
    render(<GrantRequestDialog />);
    const dialog = await screen.findByTestId('grant-request-dialog');
    expect(dialog.className).toContain('h-[min(520px');
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 of 2 waiting');
    expect(within(dialog).getByText('Its reason: Short.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/much longer reason/)).toBeNull();
    // Allow and Decline are in the footer after the scrolling body, not inside it.
    const allow = within(dialog).getByTestId('grant-request-allow');
    const body = within(dialog).getByTestId('grant-request-list').parentElement!;
    expect(body).toHaveClass('overflow-auto');
    expect(body).not.toContainElement(allow);
    expect(dialog.lastElementChild).toContainElement(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledWith('g1', true));
    // The next request takes the first one's place in the same panel, with its answers in the same footer.
    await waitFor(() => expect(within(dialog).getByText(/much longer reason/)).toBeInTheDocument());
    expect(dialog.lastElementChild).toContainElement(within(dialog).getByTestId('grant-request-allow'));
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 waiting');
  });

  it('moves focus to the next request\'s Allow, and keeps the count in a status region', async () => {
    useGrantRequestStore.getState().add(asks('g1', 0, 'Short.'));
    useGrantRequestStore.getState().add(asks('g2', 5, 'Second.'));
    useGrantRequestStore.getState().review('a1');
    render(<GrantRequestDialog />);
    const dialog = await screen.findByTestId('grant-request-dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 of 2 waiting');
    const user = userEvent.setup();
    within(dialog).getByTestId('grant-request-allow').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(within(dialog).getByText('Its reason: Second.')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByTestId('grant-request-allow')));
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 waiting');
    // The last answer closes the dialog; the Modal returns focus to where it was.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByTestId('grant-request-dialog')).toBeNull());
  });

  it('shows a failed answer above the buttons, on the request it was for', async () => {
    window.clubhouse.agent.answerGrantRequest = vi.fn(async () => ({ ok: false as const, error: 'Agent not found' }));
    useGrantRequestStore.getState().add(asks('g1', 0, 'Short.'));
    useGrantRequestStore.getState().review('a1');
    render(<GrantRequestDialog />);
    fireEvent.click(await screen.findByTestId('grant-request-decline'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Agent not found');
    const footer = screen.getByTestId('grant-request-dialog').lastElementChild!;
    expect(footer).toContainElement(alert);
    expect(footer.querySelector('[role="alert"]')!.compareDocumentPosition(screen.getByTestId('grant-request-decline')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('grant-request-decline')).toBeEnabled());
  });
});
