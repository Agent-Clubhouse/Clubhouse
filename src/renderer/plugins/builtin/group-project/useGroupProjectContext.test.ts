/**
 * Behavioral tests for useGroupProjectContext — specifically the optimistic
 * local update after remote GP mutations over annex.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupProjectContext } from './useGroupProjectContext';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';

// Mock annex client methods on window.clubhouse
const mockGpUpdate = vi.fn().mockResolvedValue(undefined);
const mockGpBulletinDigest = vi.fn().mockResolvedValue([]);
const mockGpBulletinTopic = vi.fn().mockResolvedValue([]);
const mockGpBulletinAll = vi.fn().mockResolvedValue([]);
const mockGpInjectMessage = vi.fn().mockResolvedValue(true);
const mockGpDeleteMessage = vi.fn().mockResolvedValue({ deleted: true });
const mockGpDeleteTopic = vi.fn().mockResolvedValue({ deleted: true });
const mockGpSetTopicProtection = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).clubhouse = {
    annexClient: {
      gpUpdate: mockGpUpdate,
      gpBulletinDigest: mockGpBulletinDigest,
      gpBulletinTopic: mockGpBulletinTopic,
      gpBulletinAll: mockGpBulletinAll,
      gpInjectMessage: mockGpInjectMessage,
      gpDeleteMessage: mockGpDeleteMessage,
      gpDeleteTopic: mockGpDeleteTopic,
      gpSetTopicProtection: mockGpSetTopicProtection,
    },
    groupProject: {
      getBulletinDigest: vi.fn().mockResolvedValue([]),
      getTopicMessages: vi.fn().mockResolvedValue([]),
      getAllMessages: vi.fn().mockResolvedValue([]),
      injectMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
      deleteTopic: vi.fn().mockResolvedValue(true),
      setTopicProtection: vi.fn().mockResolvedValue(true),
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
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

    expect(result.current.isRemote).toBe(true);
    expect(result.current.project).not.toBeNull();
    expect(result.current.project!.name).toBe('Test GP');
  });

  it('routes update through annex client when remote', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

    await act(async () => {
      await result.current.update(GP_ID, { description: 'Updated desc' });
    });

    expect(mockGpUpdate).toHaveBeenCalledWith(SAT_ID, GP_ID, { description: 'Updated desc' });
  });

  it('optimistically updates local remote GP store after remote mutation', async () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

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
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

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
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

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
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

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
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));

    await act(async () => {
      await result.current.injectMessage('agent-1', 'hello world');
    });

    expect(mockGpInjectMessage).toHaveBeenCalledWith(SAT_ID, 'agent-1', 'hello world');
  });

  it('returns loaded=true for remote context', () => {
    seedRemoteGP();
    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));
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

    const { result } = renderHook(() => useGroupProjectContext(GP_ID, true, SAT_ID));
    expect(result.current.members).toHaveLength(2);
    expect(result.current.members[0].agentName).toBe('Alpha');
  });
});

describe('useGroupProjectContext — local mode', () => {
  it('returns loaded from local store', () => {
    useGroupProjectStore.setState({ loaded: false, projects: [] });
    const { result } = renderHook(() => useGroupProjectContext('gp-1', false, null));
    expect(result.current.loaded).toBe(false);
    expect(result.current.isRemote).toBe(false);
  });
});
