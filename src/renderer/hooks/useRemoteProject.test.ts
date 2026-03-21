import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRemoteProject } from './useRemoteProject';

vi.mock('../stores/remoteProjectStore', () => ({
  isRemoteProjectId: (id: string) => id.startsWith('remote||'),
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const rest = id.slice('remote||'.length);
    const sep = rest.indexOf('||');
    if (sep === -1) return null;
    return { satelliteId: rest.slice(0, sep), agentId: rest.slice(sep + 2) };
  },
}));

describe('useRemoteProject', () => {
  it('returns not remote for null projectId', () => {
    const { result } = renderHook(() => useRemoteProject(null));
    expect(result.current.isRemote).toBe(false);
    expect(result.current.satelliteId).toBeNull();
    expect(result.current.originalProjectId).toBeNull();
  });

  it('returns not remote for undefined projectId', () => {
    const { result } = renderHook(() => useRemoteProject(undefined));
    expect(result.current.isRemote).toBe(false);
  });

  it('returns not remote for local project ID', () => {
    const { result } = renderHook(() => useRemoteProject('local-proj-123'));
    expect(result.current.isRemote).toBe(false);
    expect(result.current.satelliteId).toBeNull();
  });

  it('returns remote info for namespaced project ID', () => {
    const { result } = renderHook(() => useRemoteProject('remote||sat-abc||proj-xyz'));
    expect(result.current.isRemote).toBe(true);
    expect(result.current.satelliteId).toBe('sat-abc');
    expect(result.current.originalProjectId).toBe('proj-xyz');
  });

  it('memoizes the result for the same projectId', () => {
    const { result, rerender } = renderHook(
      ({ pid }) => useRemoteProject(pid),
      { initialProps: { pid: 'remote||sat-1||proj-1' } },
    );
    const first = result.current;
    rerender({ pid: 'remote||sat-1||proj-1' });
    expect(result.current).toBe(first);
  });
});
