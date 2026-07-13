/**
 * Behavioral tests for useGroupProjectContext — specifically the optimistic
 * local update after remote GP mutations over annex.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupProjectContext } from './useGroupProjectContext';
import type { AnnexAPI } from '../../../../shared/plugin-types';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';

// Mock annex API — passed directly as the 4th arg to useGroupProjectContext
const mockGpUpdate = vi.fn().mockResolvedValue(undefined);
const mockGpBulletinDigest = vi.fn().mockResolvedValue([]);
const mockGpBulletinTopic = vi.fn().mockResolvedValue([]);
const mockGpBulletinAll = vi.fn().mockResolvedValue([]);
const mockGpInjectMessage = vi.fn().mockResolvedValue(true);
const mockGpDeleteMessage = vi.fn().mockResolvedValue({ deleted: true });
const mockGpDeleteTopic = vi.fn().mockResolvedValue({ deleted: true });
const mockGpSetTopicProtection = vi.fn().mockResolvedValue(undefined);
const mockGpSetPolling = vi.fn().mockResolvedValue({ pollingEnabled: true, members: [] });

const mockAnnex = {
  gpUpdate: mockGpUpdate,
  gpBulletinDigest: mockGpBulletinDigest,
  gpBulletinTopic: mockGpBulletinTopic,
  gpBulletinAll: mockGpBulletinAll,
  gpInjectMessage: mockGpInjectMessage,
  gpDeleteMessage: mockGpDeleteMessage,
  gpDeleteTopic: mockGpDeleteTopic,
  gpSetTopicProtection: mockGpSetTopicProtection,
  gpSetPolling: mockGpSetPolling,
} as unknown as AnnexAPI;

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).clubhouse = {
    groupProject: {
      getBulletinDigest: vi.fn().mockResolvedValue([]),
      getTopicMessages: vi.fn().mockResolvedValue([]),
      getAllMessages: vi.fn().mockResolvedValue([]),
      injectMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
      deleteTopic: vi.fn().mockResolvedValue(true),
      setTopicProtection: vi.fn().mockResolvedValue(true),
      setPolling: vi.fn().mockResolvedValue({ pollingEnabled: true, members: [] }),
    },
  };

  // Reset stores
  useRemoteProjectStore.setState({
    remoteGroupProjects: {},
    remoteGroupProjectMembers: {},
  });
  useGroupProjectStore.setState({
    projects: [],
    loaded: false,
  });
});

describe('useGroupProjectContext — remote optimistic update', () => {
  const SAT_ID = 'sat-abc';
  const GP_ID = 'gp-123';

  function seedRemoteGP() {
    useRemoteProjectStore.setState({
      remoteGroupProjects: {
        [SAT_ID]: [
          {
            id: GP_ID,
            name: 'Test GP',
            description: 'Original description',
            instructions: 'Original instructions',
            metadata: { pollingEnabled: false, shoulderTapEnabled: false },
          },
        ],
      },
    });
  }

  it('resolves remote project from store', () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    expect(result.current.isRemote).toBe(true);
    expect(result.current.project).not.toBeNull();
    expect(result.current.project!.name).toBe('Test GP');
  });

  it('routes update through annex client when remote', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.update(GP_ID, { description: 'Updated desc' });
    });

    expect(mockGpUpdate).toHaveBeenCalledWith(SAT_ID, GP_ID, { description: 'Updated desc' });
  });

  it('optimistically updates local remote GP store after remote mutation', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.update(GP_ID, { description: 'New desc' });
    });

    // The remote GP store should reflect the optimistic update
    const remoteGPs = useRemoteProjectStore.getState().remoteGroupProjects[SAT_ID] as any[];
    const updated = remoteGPs.find((p) => p.id === GP_ID);
    expect(updated).toBeDefined();
    expect(updated.description).toBe('New desc');
  });

  it('merges metadata rather than replacing during optimistic update', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.update(GP_ID, { metadata: { pollingEnabled: true } });
    });

    const remoteGPs = useRemoteProjectStore.getState().remoteGroupProjects[SAT_ID] as any[];
    const updated = remoteGPs.find((p) => p.id === GP_ID);
    expect(updated.metadata.pollingEnabled).toBe(true);
    // Original metadata keys should be preserved
    expect(updated.metadata.shoulderTapEnabled).toBe(false);
  });

  it('routes fetchDigest through annex client when remote', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    mockGpBulletinDigest.mockResolvedValue([{ topic: 'test', messageCount: 5 }]);

    let digest: any;
    await act(async () => {
      digest = await result.current.fetchDigest(GP_ID);
    });

    expect(mockGpBulletinDigest).toHaveBeenCalledWith(SAT_ID, GP_ID, undefined);
    expect(digest).toEqual([{ topic: 'test', messageCount: 5 }]);
  });

  it('routes fetchAllMessages through annex client when remote', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    const mockMessages = [{ id: 'msg-1', sender: 'agent-1', topic: 'test', body: 'hello', timestamp: '2026-04-04T00:00:00Z' }];
    mockGpBulletinAll.mockResolvedValue(mockMessages);

    let messages: any;
    await act(async () => {
      messages = await result.current.fetchAllMessages(GP_ID);
    });

    expect(mockGpBulletinAll).toHaveBeenCalledWith(SAT_ID, GP_ID, undefined, undefined);
    expect(messages).toEqual(mockMessages);
  });

  it('routes injectMessage through annex client when remote', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.injectMessage('agent-1', 'hello world');
    });

    expect(mockGpInjectMessage).toHaveBeenCalledWith(SAT_ID, 'agent-1', 'hello world');
  });

  it('routes setPolling through annex client when remote and optimistically updates the setting', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.setPolling(GP_ID, true);
    });

    expect(mockGpSetPolling).toHaveBeenCalledWith(SAT_ID, GP_ID, true);
    // Does NOT fall back to the two-step update+inject path.
    expect(mockGpUpdate).not.toHaveBeenCalled();

    const remoteGPs = useRemoteProjectStore.getState().remoteGroupProjects[SAT_ID] as any[];
    const updated = remoteGPs.find((p) => p.id === GP_ID);
    expect(updated.metadata.pollingEnabled).toBe(true);
    // Original metadata keys are preserved.
    expect(updated.metadata.shoulderTapEnabled).toBe(false);
  });

  it('returns loaded=true for remote context', () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));
    expect(result.current.loaded).toBe(true);
  });

  it('resolves members from remote store', () => {
    seedRemoteGP();
    useRemoteProjectStore.setState({
      remoteGroupProjectMembers: {
        [`${SAT_ID}::${GP_ID}`]: [
          { agentId: 'agent-1', agentName: 'Alpha', status: 'connected' },
          { agentId: 'agent-2', agentName: 'Beta', status: 'sleeping' },
        ],
      },
    });

    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID, mockAnnex));
    expect(result.current.members).toHaveLength(2);
    expect(result.current.members[0].agentName).toBe('Alpha');
  });
});

describe('useGroupProjectContext — local mode', () => {
  it('returns loaded from local store', () => {
    useGroupProjectStore.setState({ loaded: false, projects: [] });
    const { result } = renderHook(() => useGroupProjectContext('gp-1', false, null, mockAnnex));
    expect(result.current.loaded).toBe(false);
    expect(result.current.isRemote).toBe(false);
  });

  it('routes setPolling through the local groupProject IPC (not annex) when local', async () => {
    useGroupProjectStore.setState({ loaded: true, projects: [] });
    const { result } = renderHook(() => useGroupProjectContext('gp-1', false, null, mockAnnex));

    await act(async () => {
      await result.current.setPolling('gp-1', false);
    });

    expect((window as any).clubhouse.groupProject.setPolling).toHaveBeenCalledWith('gp-1', false);
    expect(mockGpSetPolling).not.toHaveBeenCalled();
  });
});

describe('useGroupProjectContext — remote namespace stripping (Mission 67)', () => {
  const SAT_ID = 'sat-abc';
  const BARE_ID = 'gp-123';
  const NAMESPACED_ID = `remote||${SAT_ID}||${BARE_ID}`;

  function seedRemoteGP() {
    useRemoteProjectStore.setState({
      remoteGroupProjects: {
        [SAT_ID]: [
          {
            id: BARE_ID,
            name: 'Test GP',
            description: 'desc',
            instructions: 'instr',
            metadata: {},
          },
        ],
      },
    });
  }

  // Canvas state on a remote canvas re-namespaces metadata.groupProjectId to
  // `remote||satId||originalId`. The widget passes that to the context's fetch
  // helpers, which previously forwarded it untouched to the annex client REST
  // path. The satellite registry only knows the bare ID, so it 404'd and
  // returned [] — the user saw an empty topic list with no history.
  // The fix strips the prefix in every read/write helper before crossing the
  // annex client boundary.

  it('strips namespace from gpId before calling gpBulletinDigest', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.fetchDigest(NAMESPACED_ID);
    });

    expect(mockGpBulletinDigest).toHaveBeenCalledWith(SAT_ID, BARE_ID, undefined);
    expect(mockGpBulletinDigest).not.toHaveBeenCalledWith(SAT_ID, NAMESPACED_ID, undefined);
  });

  it('strips namespace from gpId before calling gpBulletinAll', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.fetchAllMessages(NAMESPACED_ID);
    });

    expect(mockGpBulletinAll).toHaveBeenCalledWith(SAT_ID, BARE_ID, undefined, undefined);
    expect(mockGpBulletinAll).not.toHaveBeenCalledWith(SAT_ID, NAMESPACED_ID, undefined, undefined);
  });

  it('strips namespace from gpId before calling gpBulletinTopic', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.fetchTopicMessages(NAMESPACED_ID, 'general');
    });

    expect(mockGpBulletinTopic).toHaveBeenCalledWith(SAT_ID, BARE_ID, 'general', undefined, undefined);
  });

  it('strips namespace from gpId before calling gpUpdate', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.update(NAMESPACED_ID, { description: 'new' });
    });

    expect(mockGpUpdate).toHaveBeenCalledWith(SAT_ID, BARE_ID, { description: 'new' });
  });

  it('strips namespace from gpId before calling gpDeleteMessage', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.deleteMessage(NAMESPACED_ID, 'general', 'msg-1');
    });

    expect(mockGpDeleteMessage).toHaveBeenCalledWith(SAT_ID, BARE_ID, 'general', 'msg-1');
  });

  it('strips namespace from gpId before calling gpDeleteTopic', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.deleteTopic(NAMESPACED_ID, 'general');
    });

    expect(mockGpDeleteTopic).toHaveBeenCalledWith(SAT_ID, BARE_ID, 'general');
  });

  it('strips namespace from gpId before calling gpSetTopicProtection', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.setTopicProtection(NAMESPACED_ID, 'general', true);
    });

    expect(mockGpSetTopicProtection).toHaveBeenCalledWith(SAT_ID, BARE_ID, 'general', true);
  });

  it('returns full topic history end-to-end when satellite serves multiple topics with messages', async () => {
    // Acceptance criterion: 2 topics × 5 messages each, satellite joining via
    // annex sees full topic history. Stub the satellite responses, drive the
    // controller-side context, and verify history flows back into the widget.
    const topic1Messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-t1-${i}`,
      sender: `agent-${i}`,
      topic: 'general',
      body: `general message ${i}`,
      timestamp: `2026-04-10T00:00:0${i}.000Z`,
    }));
    const topic2Messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-t2-${i}`,
      sender: `agent-${i}`,
      topic: 'shoulder-tap',
      body: `shoulder-tap message ${i}`,
      timestamp: `2026-04-10T00:00:1${i}.000Z`,
    }));
    const allMessages = [...topic1Messages, ...topic2Messages];

    mockGpBulletinDigest.mockResolvedValue([
      { topic: 'general', messageCount: 5, newMessageCount: 0, latestTimestamp: topic1Messages[4].timestamp, isProtected: false },
      { topic: 'shoulder-tap', messageCount: 5, newMessageCount: 0, latestTimestamp: topic2Messages[4].timestamp, isProtected: false },
    ]);
    mockGpBulletinAll.mockResolvedValue(allMessages);

    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(NAMESPACED_ID, true, SAT_ID, mockAnnex));

    let digest: any;
    let messages: any;
    await act(async () => {
      digest = await result.current.fetchDigest(NAMESPACED_ID);
      messages = await result.current.fetchAllMessages(NAMESPACED_ID);
    });

    // Both REST calls were made with the bare gpId, not the namespaced one.
    expect(mockGpBulletinDigest).toHaveBeenCalledWith(SAT_ID, BARE_ID, undefined);
    expect(mockGpBulletinAll).toHaveBeenCalledWith(SAT_ID, BARE_ID, undefined, undefined);

    // Full history is returned to the widget.
    expect(digest).toHaveLength(2);
    expect(digest.find((d: any) => d.topic === 'general').messageCount).toBe(5);
    expect(digest.find((d: any) => d.topic === 'shoulder-tap').messageCount).toBe(5);
    expect(messages).toHaveLength(10);
    expect(messages.filter((m: any) => m.topic === 'general')).toHaveLength(5);
    expect(messages.filter((m: any) => m.topic === 'shoulder-tap')).toHaveLength(5);
  });

  it('still passes bare gpId through unchanged when used directly without namespacing', async () => {
    // Defensive: if a caller already strips the prefix (or there's no prefix
    // because the canvas hasn't applied the namespace step), the helpers
    // must not break the bare ID.
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(BARE_ID, true, SAT_ID, mockAnnex));

    await act(async () => {
      await result.current.fetchDigest(BARE_ID);
      await result.current.fetchAllMessages(BARE_ID);
    });

    expect(mockGpBulletinDigest).toHaveBeenLastCalledWith(SAT_ID, BARE_ID, undefined);
    expect(mockGpBulletinAll).toHaveBeenLastCalledWith(SAT_ID, BARE_ID, undefined, undefined);
  });
});
