import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useModelOptions } from './useModelOptions';
import { useProjectStore } from '../stores/projectStore';

const OPTIONS = [{ id: 'default', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }];

describe('useModelOptions', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null } as never);
    window.clubhouse.agent.getModelOptions = vi.fn(async () => OPTIONS) as never;
  });

  it('loads the options for a path', async () => {
    const { result } = renderHook(() => useModelOptions('claude-code', '/work/proj'));
    expect(result.current).toEqual({ options: [{ id: 'default', label: 'Default' }], loading: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.options).toEqual(OPTIONS);
    expect(window.clubhouse.agent.getModelOptions).toHaveBeenCalledWith('/work/proj', 'claude-code');
  });

  it('is not loading with no path, and reads nothing', () => {
    const { result } = renderHook(() => useModelOptions('claude-code', ''));
    expect(result.current.loading).toBe(false);
    expect(window.clubhouse.agent.getModelOptions).not.toHaveBeenCalled();
  });

  // #2375: going from no path to a path used to render once as loaded, with only Default.
  it('has no render that looks loaded between a path change and its options', async () => {
    const renders: Array<{ path: string; loading: boolean; ids: string[] }> = [];
    const { rerender } = renderHook(({ path }) => {
      const r = useModelOptions('claude-code', path);
      renders.push({ path, loading: r.loading, ids: r.options.map((o) => o.id) });
      return r;
    }, { initialProps: { path: '' } });
    rerender({ path: '/work/proj' });
    await waitFor(() => expect(renders.at(-1)?.loading).toBe(false));
    for (const r of renders.filter((x) => x.path && !x.loading)) expect(r.ids).toEqual(['default', 'sonnet']);
  });

  it('drops the old provider\'s options in the same render as the provider changes', async () => {
    const renders: Array<{ o: string; loading: boolean; ids: string[] }> = [];
    const { rerender } = renderHook(({ o }) => {
      const r = useModelOptions(o, '/work/proj');
      renders.push({ o, loading: r.loading, ids: r.options.map((x) => x.id) });
      return r;
    }, { initialProps: { o: 'claude-code' } });
    await waitFor(() => expect(renders.at(-1)?.loading).toBe(false));
    window.clubhouse.agent.getModelOptions = vi.fn(() => new Promise(() => {})) as never;
    rerender({ o: 'codex-cli' });
    for (const r of renders.filter((x) => x.o === 'codex-cli')) expect(r).toEqual({ o: 'codex-cli', loading: true, ids: ['default'] });
  });

  it('ignores a list that arrives after the path changed', async () => {
    const answers: Record<string, (v: unknown) => void> = {};
    window.clubhouse.agent.getModelOptions = vi.fn((p: string) => new Promise((r) => { answers[p] = r; })) as never;
    const { result, rerender } = renderHook(({ path }) => useModelOptions('claude-code', path), { initialProps: { path: '/a' } });
    rerender({ path: '/b' });
    await act(async () => { answers['/a']([{ id: 'from-a', label: 'A' }]); });
    expect(result.current.loading).toBe(true);
    await act(async () => { answers['/b'](OPTIONS); });
    expect(result.current).toEqual({ options: OPTIONS, loading: false });
  });

  it('settles on the placeholder when the read fails', async () => {
    window.clubhouse.agent.getModelOptions = vi.fn(async () => { throw new Error('no cli'); }) as never;
    const { result } = renderHook(() => useModelOptions('claude-code', '/work/proj'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.options).toEqual([{ id: 'default', label: 'Default' }]);
  });
});
