import { waitFor } from '@testing-library/react';
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
});
