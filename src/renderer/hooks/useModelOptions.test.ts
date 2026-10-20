import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

  it('drops the old provider\'s options the moment the provider changes', async () => {
    const { result, rerender } = renderHook(({ o }) => useModelOptions(o, '/work/proj'), { initialProps: { o: 'claude-code' } });
    await waitFor(() => expect(result.current.options).toEqual(OPTIONS));
    window.clubhouse.agent.getModelOptions = vi.fn(() => new Promise(() => {})) as never;
    rerender({ o: 'codex-cli' });
    expect(result.current).toEqual({ options: [{ id: 'default', label: 'Default' }], loading: true });
  });

  it('settles on the placeholder when the read fails', async () => {
    window.clubhouse.agent.getModelOptions = vi.fn(async () => { throw new Error('no cli'); }) as never;
    const { result } = renderHook(() => useModelOptions('claude-code', '/work/proj'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.options).toEqual([{ id: 'default', label: 'Default' }]);
  });
});
