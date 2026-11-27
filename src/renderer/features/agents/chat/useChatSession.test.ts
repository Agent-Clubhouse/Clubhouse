import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createChatViewState, useChatStore } from '../../../stores/chatStore';
import { useToastStore } from '../../../stores/toastStore';
import { useChatActions, useEarlierHistory, useChatDraftStore } from './useChatSession';

describe('useChatActions results (#2057)', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('reads current session identity live rather than from action creation', () => {
    useChatStore.setState({ agents: { 'agent-1': { ...createChatViewState('agent-1'), sessionId: 'old' } } });
    const { result } = renderHook(() => useChatActions('agent-1'));
    expect(result.current.isSessionCurrent?.('old')).toBe(true);
    useChatStore.setState({ agents: { 'agent-1': { ...createChatViewState('agent-1'), sessionId: 'new' } } });
    expect(result.current.isSessionCurrent?.('old')).toBe(false);
    expect(result.current.isSessionCurrent?.('new')).toBe(true);
  });

  it('resolves true when interrupt and setLevel succeed', async () => {
    useChatStore.setState({ interrupt: vi.fn(async () => {}), setLevel: vi.fn(async () => {}) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.interrupt()).resolves.toBe(true);
    await expect(result.current.setLevel('ask')).resolves.toBe(true);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('reports a lost send acknowledgement without claiming non-delivery', async () => {
    useChatStore.setState({ send: vi.fn(async () => { throw new Error('Acknowledgement timed out'); }) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.send('possibly delivered')).resolves.toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Message delivery unconfirmed: Acknowledgement timed out']);
  });

  it('resolves false with a toast when interrupt fails', async () => {
    useChatStore.setState({ interrupt: vi.fn(async () => { throw new Error('not running'); }) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.interrupt()).resolves.toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Couldn't stop the turn: not running"]);
  });

  it('resolves false with a toast when setLevel fails', async () => {
    useChatStore.setState({ setLevel: vi.fn(async () => { throw new Error('not live'); }) });
    const { result } = renderHook(() => useChatActions('agent-1'));
    await expect(result.current.setLevel('auto')).resolves.toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Couldn't change the access: not live"]);
  });
});

describe('useEarlierHistory (#2150 review)', () => {
  it('does not start a second load while one is in flight, so the held live events stay with it', () => {
    const loadTranscript = vi.fn(async () => {});
    useChatStore.setState({ loading: { 'agent-1': true }, partial: { 'agent-1': true }, loadTranscript });
    const { result } = renderHook(() => useEarlierHistory('agent-1'));
    result.current.loadAll();
    expect(loadTranscript).not.toHaveBeenCalled();

    useChatStore.setState({ loading: {} });
    result.current.loadAll();
    expect(loadTranscript).toHaveBeenCalledWith('agent-1');
  });
});


describe('send recovery races', () => {
  beforeEach(() => useChatDraftStore.setState({ drafts: {}, attachments: {}, pendingSends: {}, failedSends: {}, uncertainDrafts: {} }));
  const file = { id: 'staged-file', name: 'notes.txt', kind: 'file' as const };
  const message = () => ({ sessionId: 'session', uncertain: true, startedAt: Date.now(), text: 'first', attachments: [file] });

  it('takes one synchronous lock per agent and ignores stale completions', () => {
    const first = message();
    const other = message();
    const s = useChatDraftStore.getState();
    expect(s.beginSend('a', first)).toBe(true);
    expect(s.beginSend('a', other)).toBe(false);
    expect(s.beginSend('b', other)).toBe(true);
    s.finishSend('a', other, false);
    expect(useChatDraftStore.getState().pendingSends.a).toBe(first);
    s.finishSend('a', first, true);
    expect(useChatDraftStore.getState().pendingSends.a).toBeUndefined();
    expect(useChatDraftStore.getState().pendingSends.b).toBe(other);
    expect(useChatDraftStore.getState().failedSends.a).toBeUndefined();
  });

  it('keeps late old-session results from unlocking or restoring over a new send', () => {
    const s = useChatDraftStore.getState();
    const old = message();
    const current = { ...message(), sessionId: 'new-session' };
    s.beginSend('a', old);
    expect(s.beginSend('a', current)).toBe(true);
    expect(useChatDraftStore.getState().failedSends.a).toEqual([old]);
    s.finishSend('a', old, false, false);
    expect(useChatDraftStore.getState().drafts.a).toBeUndefined();
    expect(useChatDraftStore.getState().pendingSends.a).toBe(current);
    expect(useChatDraftStore.getState().failedSends.a).toEqual([{ ...old, uncertain: false }]);
  });

  it('retains attachment-only new drafts, and restores each failed message once in order', () => {
    const s = useChatDraftStore.getState();
    const first = message();
    const second = { ...message(), text: 'second' };
    s.beginSend('a', first);
    s.setAttachments('a', [file]);
    s.finishSend('a', first, false, false);
    s.beginSend('a', second);
    s.finishSend('a', second, false, false);
    s.restoreSend('a');
    expect(useChatDraftStore.getState().drafts.a).toBeUndefined();
    expect(useChatDraftStore.getState().failedSends.a).toEqual([{ ...first, uncertain: false }, { ...second, uncertain: false }]);
    s.setAttachments('a', []);
    s.restoreSend('a');
    s.restoreSend('a');
    expect(useChatDraftStore.getState().drafts.a).toBe('first');
    expect(useChatDraftStore.getState().attachments.a).toEqual([file]);
    expect(useChatDraftStore.getState().failedSends.a).toEqual([{ ...second, uncertain: false }]);
    s.setDraft('a', '');
    s.setAttachments('a', []);
    s.restoreSend('a');
    expect(useChatDraftStore.getState().drafts.a).toBe('second');
    expect(useChatDraftStore.getState().failedSends.a).toEqual([]);
  });
});
