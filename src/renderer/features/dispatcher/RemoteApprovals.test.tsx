import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import type { MobileGrantRequest } from '../../../shared/mobile-control';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { _resetLeadStoreForTesting, useLeadStore } from './leadStore';
import { RemoteApprovals, approvalLine } from './RemoteApprovals';

const LEAD: DispatcherLeadState = {
  available: true, canChoose: true, role: 'lead', following: false, tookBack: false,
  lead: { machine: 'desk', name: 'Desk', self: true, online: true, dispatcherOn: true },
  choices: [
    { machine: 'desk', name: 'Desk', self: true, online: true, dispatcherOn: true },
    { machine: 'laptop', name: 'Laptop', self: false, online: true, dispatcherOn: true },
  ],
  confirmedBy: ['Laptop'], waitingOn: [], clearedFor: null, changedByName: 'Desk', changedAt: '2026-11-13T10:00:00.000Z',
  leadLastSeen: null, outbox: { waiting: 0, oldestAt: null, expired: 0, failed: null },
};
const REQUEST = {
  requestId: 'gr_1', kind: 'call', projectId: 'p1', agent: { agentId: 'docs', name: 'docs-agent' }, actions: ['git.push'], actionLabels: ['Push'],
  where: 'docs', toolName: 'git_push', target: null, summary: 'docs-agent wants to push to main', detail: null, arguments: null, reason: null,
  allowEffect: 'Allows this one push.', requestedAt: '2026-11-13T10:00:00.000Z', expiresAt: '2026-11-14T10:00:00.000Z', answers: ['allow_once', 'decline'],
} as MobileGrantRequest;
const satellite = (grantRequests: MobileGrantRequest[], state = 'connected') => ({
  id: 'sat-laptop', alias: 'Laptop', icon: 'computer', color: 'indigo', fingerprint: 'LAPTOP', state, host: 'h', mainPort: 1, pairingPort: 2, lastError: null,
  snapshot: { grantRequests },
});

beforeEach(() => {
  _resetLeadStoreForTesting();
  window.clubhouse.dispatcher.getLead = vi.fn(async () => useLeadStore.getState().state!);
  window.clubhouse.dispatcher.answerRemoteApproval = vi.fn(async () => {});
  useLeadStore.setState({ state: LEAD });
  useAnnexClientStore.setState({ satellites: [satellite([REQUEST])] } as never);
});

describe('approvals from other computers in the lead’s chat (#3354)', () => {
  it('lists them with the computer first, and a person’s click answers on that computer', async () => {
    render(<RemoteApprovals />);
    await act(async () => {});
    expect(screen.getByTestId('dispatcher-remote-approval').textContent).toContain('Laptop: docs-agent wants to push to main');
    fireEvent.click(screen.getByTestId('dispatcher-remote-approval-allow_once'));
    await waitFor(() => expect(window.clubhouse.dispatcher.answerRemoteApproval).toHaveBeenCalledWith('laptop', 'gr_1', 'allow_once'));
    expect(screen.queryByTestId('dispatcher-remote-approval-allow_lasting')).toBeNull();
  });

  it('drops one answered on its own computer with that computer’s next snapshot', async () => {
    render(<RemoteApprovals />);
    await act(async () => {});
    act(() => useAnnexClientStore.setState({ satellites: [satellite([])] } as never));
    expect(screen.queryByTestId('dispatcher-remote-approval')).toBeNull();
  });

  it('says why an answer was refused there', async () => {
    window.clubhouse.dispatcher.answerRemoteApproval = vi.fn(async () => { throw new Error('It was already answered, or it ended, on that computer.'); });
    render(<RemoteApprovals />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('dispatcher-remote-approval-decline'));
    expect((await screen.findByTestId('dispatcher-remote-approval-error')).textContent).toContain('already answered');
  });

  it('shows nothing on a follower or a peer, or from an offline computer, and leaves an update to its computer', async () => {
    useLeadStore.setState({ state: { ...LEAD, role: 'follower' } });
    const { rerender } = render(<RemoteApprovals />);
    await act(async () => {});
    expect(screen.queryByTestId('dispatcher-remote-approvals')).toBeNull();
    act(() => useLeadStore.setState({ state: LEAD }));
    act(() => useAnnexClientStore.setState({ satellites: [satellite([REQUEST], 'disconnected')] } as never));
    rerender(<RemoteApprovals />);
    expect(screen.queryByTestId('dispatcher-remote-approvals')).toBeNull();
    act(() => useAnnexClientStore.setState({ satellites: [satellite([{ ...REQUEST, update: {} as never }])] } as never));
    expect(screen.getByTestId('dispatcher-remote-approval').textContent).toContain('Answer it on Laptop.');
    expect(approvalLine({ machine: 'laptop', machineName: 'Laptop', request: REQUEST })).toBe('Laptop: docs-agent wants to push to main');
  });
});
