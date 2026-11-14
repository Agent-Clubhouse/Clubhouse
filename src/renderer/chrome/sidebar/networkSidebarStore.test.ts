import { useVisibleProjectLinks } from './projectLinks';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { waitFor, renderHook, act } from '@testing-library/react';
import { _resetNetworkSidebarForTesting, useNetworkSidebarStore } from './networkSidebarStore';
import type { ProjectLinksView } from '../../../shared/project-links';

describe('shared project links in the renderer', () => {
  let changed: (view: ProjectLinksView) => void;
  beforeEach(() => {
    _resetNetworkSidebarForTesting();
    window.clubhouse.project.hydrateProjectLinks = vi.fn().mockResolvedValue({ revision: 0, links: [], keptSeparate: [] });
    window.clubhouse.project.onProjectLinksChanged = vi.fn((fn) => { changed = fn; return () => {}; });
    window.clubhouse.project.changeProjectLinks = vi.fn();
  });
  afterEach(() => {
    _resetNetworkSidebarForTesting();
    delete (window.clubhouse.project as Partial<typeof window.clubhouse.project>).hydrateProjectLinks;
  });
  it('imports legacy choices without rewriting them and follows updates from another computer/window', async () => {
    const legacy = { show: 'local', links: [['site', 'copy']], keptSeparate: ['a\nb'] };
    localStorage.setItem('clubhouse.networkSidebar', JSON.stringify(legacy));
    useNetworkSidebarStore.getState().retryHandoffLinks();
    await waitFor(() => expect(window.clubhouse.project.hydrateProjectLinks).toHaveBeenCalledWith(legacy));
    changed({ revision: 1, links: [['manual', 'remote']], keptSeparate: ['site\ncopy'] });
    expect(useNetworkSidebarStore.getState().links).toEqual([['manual', 'remote']]);
    changed({ revision: 0, links: [], keptSeparate: [] });
    expect(useNetworkSidebarStore.getState().links).toEqual([['manual', 'remote']]);
    useNetworkSidebarStore.getState().setShow('all');
    expect(JSON.parse(localStorage.getItem('clubhouse.networkSidebar')!)).toEqual({ ...legacy, show: 'all' });
  });
  it('replays pending edits over remote updates and applies the acknowledgement once', async () => {
    let finish!: (v: ProjectLinksView) => void;
    vi.mocked(window.clubhouse.project.changeProjectLinks).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    useNetworkSidebarStore.getState().link('site', 'copy');
    expect(useNetworkSidebarStore.getState().links).toEqual([['site', 'copy']]);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    changed({ revision: 1, links: [['copy', 'third']], keptSeparate: [] });
    expect(useNetworkSidebarStore.getState().links[0].sort()).toEqual(['copy', 'site', 'third']);
    finish({ revision: 2, links: [['copy', 'site', 'third']], keptSeparate: [] });
    await waitFor(() => expect(useNetworkSidebarStore.getState().links).toEqual([['copy', 'site', 'third']]));
    changed({ revision: 3, links: [], keptSeparate: ['copy\nsite'] });
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
  });
  it('hides unpaired computers locally without changing the shared set and restores them on re-pair', async () => {
    const shared = { revision: 1, links: [['site', 'remote||bb||copy']], keptSeparate: [] };
    vi.mocked(window.clubhouse.project.hydrateProjectLinks).mockResolvedValue(shared);
    useNetworkSidebarStore.getState().retryHandoffLinks();
    await waitFor(() => expect(useNetworkSidebarStore.getState().links).toEqual(shared.links));
    useAnnexClientStore.setState({ satellites: [{ id: 'bb', state: 'connected' }] } as never);
    const { result } = renderHook(useVisibleProjectLinks);
    expect(result.current).toEqual(shared.links);
    act(() => useAnnexClientStore.setState({ satellites: [] }));
    expect(result.current).toEqual([]);
    expect(useNetworkSidebarStore.getState().links).toEqual(shared.links);
    expect(window.clubhouse.project.changeProjectLinks).not.toHaveBeenCalled();
    // Another window/member's unchanged shared snapshot cannot unhide an unpaired computer.
    act(() => changed({ ...shared, revision: 2 }));
    expect(result.current).toEqual([]);
    act(() => useAnnexClientStore.setState({ satellites: [{ id: 'bb', state: 'disconnected' }] } as never));
    expect(result.current).toEqual(shared.links);
    expect(window.clubhouse.project.changeProjectLinks).not.toHaveBeenCalled();
  });
  it('drops permanently rejected edits, rolls them back, reports the error and lets later edits through', async () => {
    const save = vi.mocked(window.clubhouse.project.changeProjectLinks);
    save.mockRejectedValueOnce(new Error('Invalid project reference.'))
      .mockResolvedValueOnce({ revision: 1, links: [['good', 'copy']], keptSeparate: [] });
    useNetworkSidebarStore.getState().link('bad', 'copy');
    useNetworkSidebarStore.getState().link('good', 'copy');
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useNetworkSidebarStore.getState().links).toEqual([['good', 'copy']]));
    expect(useNetworkSidebarStore.getState()).toMatchObject({ handoffLinkError: true, linkErrorRetryable: false });
    changed({ revision: 2, links: [], keptSeparate: [] });
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
  });
  it.each(['Annex identity is not ready for project links.', 'ECONNRESET'])('keeps a known transient failure for retry (%s)', async (message) => {
    const save = vi.mocked(window.clubhouse.project.changeProjectLinks);
    save.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce({ revision: 1, links: [['site', 'copy']], keptSeparate: [] });
    useNetworkSidebarStore.getState().link('site', 'copy');
    await waitFor(() => expect(useNetworkSidebarStore.getState().linkErrorRetryable).toBe(true));
    changed({ revision: 0, links: [], keptSeparate: [] });
    expect(useNetworkSidebarStore.getState().links).toEqual([['site', 'copy']]);
    useNetworkSidebarStore.getState().retryHandoffLinks();
    await waitFor(() => expect(useNetworkSidebarStore.getState().handoffLinkError).toBe(false));
    expect(save).toHaveBeenCalledTimes(2);
  });

});
