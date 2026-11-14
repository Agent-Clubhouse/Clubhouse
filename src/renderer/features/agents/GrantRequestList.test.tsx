import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
