import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import type { MobileGrantRequest } from '../../../shared/mobile-control';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { _resetLeadStoreForTesting, useLeadStore } from './leadStore';
import { RemoteApprovals, approvalLine, dispatcherNeedsYouLine } from './RemoteApprovals';
import { describeGrantRequest, type GrantRequest } from '../../../shared/grant-requests';

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
// The summary as Laptop's snapshot really words it: no agent name, no arguments.
const SUMMARY = describeGrantRequest({ kind: 'call', actions: ['settings.app.write'], toolName: 'set_app_setting', where: 'the app' });
const REQUEST = {
  requestId: 'gr_1', kind: 'call', projectId: 'p1', agent: { agentId: 'docs', name: 'docs-agent' }, actions: ['settings.app.write'], actionLabels: ['Change app settings'],
  where: 'the app', toolName: 'set_app_setting', target: null, summary: SUMMARY, detail: 'Turns on auto-update.',
  arguments: '{\n  "key": "autoUpdate",\n  "value": true\n}', reason: 'The user asked for updates to install themselves.',
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
    const row = screen.getByTestId('dispatcher-remote-approval');
    // Who asks and exactly what it would run, before any Allow.
    expect(row.textContent).toContain('Laptop: docs-agent wants to run set_app_setting, which needs:');
    expect(row.textContent).toContain('Its reason: The user asked for updates to install themselves.');
    expect(row.textContent).toContain('Turns on auto-update.');
    expect(screen.getByTestId('dispatcher-remote-approval-arguments').textContent).toContain('"key": "autoUpdate"');
    fireEvent.click(screen.getByTestId('dispatcher-remote-approval-allow_once'));
    await waitFor(() => expect(window.clubhouse.dispatcher.answerRemoteApproval).toHaveBeenCalledWith('laptop', 'gr_1', 'allow_once'));
    expect(screen.queryByTestId('dispatcher-remote-approval-allow_lasting')).toBeNull();
    // Taken there: no second answer while its next snapshot is on the way.
    await screen.findByTestId('dispatcher-remote-approval-answered');
    expect(screen.queryByTestId('dispatcher-remote-approval-decline')).toBeNull();
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
    expect(approvalLine({ machine: 'laptop', machineName: 'Laptop', request: REQUEST })).toBe(`Laptop: docs-agent w${SUMMARY.slice(1)}`);
  });

  it('caps long arguments, and the full text stays on the computer it came from', async () => {
    useAnnexClientStore.setState({ satellites: [satellite([{ ...REQUEST, arguments: 'x'.repeat(5_000) }])] } as never);
    render(<RemoteApprovals />);
    await act(async () => {});
    const shown = screen.getByTestId('dispatcher-remote-approval-arguments').textContent!;
    expect(shown.length).toBeLessThan(4_100);
    expect(shown).toContain('the rest is on Laptop');
  });
});

describe('the lead’s Dispatcher row in Needs you (#3354)', () => {
  const remote = (n: number) => Array.from({ length: n }, (_, i) => ({ machine: 'laptop', machineName: 'Laptop', request: { ...REQUEST, requestId: `gr_${i}` } }));
  const local = (n: number) => Array.from({ length: n }, (_, i) => ({
    requestId: `lg_${i}`, kind: 'grant', agentId: 'disp', agentName: 'Rosie', actions: ['device.manage'], where: 'the app', createdAt: '2026-11-13T09:00:00.000Z',
  })) as unknown as GrantRequest[];

  it('counts this computer’s requests and the other computers’ together', () => {
    expect(dispatcherNeedsYouLine([], [])).toBeNull();
    expect(dispatcherNeedsYouLine([], remote(3))!.message).toBe(`Laptop: docs-agent w${SUMMARY.slice(1)} (and 2 more)`);
    expect(dispatcherNeedsYouLine(local(1), remote(2))).toEqual({ message: expect.stringMatching(/\(3 requests, 2 from other computers\)$/), at: Date.parse('2026-11-13T09:00:00.000Z') });
    expect(dispatcherNeedsYouLine(local(2), [])!.message).toMatch(/\(2 requests\)$/);
    // A bad time sorts first rather than breaking the order.
    expect(dispatcherNeedsYouLine([], [{ ...remote(1)[0], request: { ...REQUEST, requestedAt: 'soon' } }])!.at).toBe(0);
  });
});
