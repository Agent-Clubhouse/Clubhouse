import { describe, it, expect } from 'vitest';
import { resolveRemoteDispatcherTarget } from './remoteDispatcherTarget';
import type { Agent } from '../../../shared/types';

const chat = { id: 'chat', projectId: '__dispatcher__', name: 'Tael', kind: 'durable', status: 'running' } as Agent;
const sat = (over: Record<string, unknown> = {}) => ({ id: 's1', fingerprint: 'FP1', snapshot: { dispatcher: { agent: chat } }, ...over }) as never;

describe('resolveRemoteDispatcherTarget', () => {
  it('opens its chat, under this computer’s ids, by the machine’s fingerprint in any case', () => {
    expect(resolveRemoteDispatcherTarget('fp1', [sat()])).toEqual({
      kind: 'chat',
      agentId: 'remote||s1||chat',
      chat: { ...chat, id: 'remote||s1||chat', projectId: 'remote||s1||__dispatcher__' },
    });
    expect(resolveRemoteDispatcherTarget('FP1', [sat({ fingerprint: 'fp1' })]).kind).toBe('chat');
  });

  it('follows the lead when it is the machine followed, whether or not a chat is known', () => {
    expect(resolveRemoteDispatcherTarget('fp1', [sat()], 'fp1')).toEqual({ kind: 'lead' });
    expect(resolveRemoteDispatcherTarget('fp1', [], 'fp1')).toEqual({ kind: 'lead' });
    expect(resolveRemoteDispatcherTarget('fp1', [sat()], 'fp2').kind).toBe('chat');
  });

  it('falls back to its details, never to nothing, when this computer has no connection or chat for it', () => {
    // The computer that was paired, not the one that paired, may hold no connection to its peer.
    expect(resolveRemoteDispatcherTarget('fp1', [])).toEqual({ kind: 'details' });
    expect(resolveRemoteDispatcherTarget('fp1', [sat({ fingerprint: 'other' })])).toEqual({ kind: 'details' });
    expect(resolveRemoteDispatcherTarget('fp1', [sat({ snapshot: null })])).toEqual({ kind: 'details' });
    expect(resolveRemoteDispatcherTarget('fp1', [sat({ snapshot: { dispatcher: { agent: null } } })])).toEqual({ kind: 'details' });
  });
});
