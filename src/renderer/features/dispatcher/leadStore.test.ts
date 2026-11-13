import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { DispatcherLeadState } from '../../../shared/dispatcher-lead';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { _resetLeadStoreForTesting, useFollowedLead, useLeadStore } from './leadStore';

const FOLLOWING: DispatcherLeadState = {
  available: true, canChoose: true, role: 'follower', following: true, tookBack: false,
  lead: { machine: 'laptop', name: 'Laptop', self: false, online: true, dispatcherOn: true },
  choices: [], confirmedBy: [], waitingOn: [], clearedFor: null, changedByName: null, changedAt: '2026-11-13T10:00:00.000Z',
  leadLastSeen: null, outbox: { waiting: 0, oldestAt: null, expired: 0, failed: null }, localNews: { count: 0, needsUser: false },
};
const SLEPT = { id: 'lead-chat', projectId: DISPATCHER_PROJECT_ID, name: 'Rosie', kind: 'durable', status: 'sleeping', executionMode: null };

beforeEach(() => {
  _resetLeadStoreForTesting();
  window.clubhouse.dispatcher.getLead = async () => useLeadStore.getState().state!;
  useLeadStore.setState({ state: FOLLOWING });
  useAnnexClientStore.setState({ satellites: [{
    id: 'sat-laptop', alias: 'Laptop', icon: 'computer', color: 'indigo', fingerprint: 'LAPTOP', state: 'connected', host: 'h', mainPort: 1, pairingPort: 2, lastError: null,
    snapshot: { dispatcher: { agent: SLEPT } },
  }] } as never);
  useRemoteProjectStore.setState({ remoteAgents: {} });
});

describe('the lead’s Dispatcher on a follower (#3352)', () => {
  it('is a chat agent, even from a snapshot taken while it slept, and follows its live run state', async () => {
    const { result } = renderHook(() => useFollowedLead());
    await act(async () => {});
    expect(result.current?.agent).toMatchObject({ id: 'remote||sat-laptop||lead-chat', executionMode: 'chat', status: 'sleeping' });
    act(() => useRemoteProjectStore.setState({ remoteAgents: { 'remote||sat-laptop||lead-chat': {
      ...SLEPT, id: 'remote||sat-laptop||lead-chat', projectId: 'remote||sat-laptop||__dispatcher__', status: 'running',
    } as never } }));
    expect(result.current?.agent).toMatchObject({ status: 'running', executionMode: 'chat' });
  });
});
