import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { LinkedProjectsSection } from './LinkedProjectsSection';
import { LinkSuggestionLine } from '../../chrome/sidebar/LinkSuggestionLine';
import { useProjectStore } from '../../stores/projectStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useNetworkSidebarStore, _resetNetworkSidebarForTesting } from '../../chrome/sidebar/networkSidebarStore';

const REMOTE = 'remote||bb||site';

describe('linking the same project on two computers (#3066)', () => {
  beforeEach(() => {
    _resetNetworkSidebarForTesting();
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'Site', path: '/site' }, { id: 'p2', name: 'Docs', path: '/docs' }] } as never);
    useAnnexClientStore.setState({ satellites: [{ id: 'bb', alias: 'Studio', fingerprint: 'bb', state: 'connected' }] } as never);
    useRemoteProjectStore.setState({ satelliteProjects: { bb: [
      { id: REMOTE, name: 'Site', path: '/srv/site', remote: true, satelliteId: 'bb', satelliteName: 'Studio', repoKey: 'github.com/org/site' },
    ] } } as never);
    window.clubhouse.project.getRepoKeys = vi.fn().mockResolvedValue({ p1: 'github.com/org/site' });
  });

  it('suggests the link once in the sidebar; Link groups them, and it isn\'t suggested again', async () => {
    render(<LinkSuggestionLine />);
    expect(await screen.findByTestId('link-suggestion')).toHaveTextContent('Site is also on Studio, with the same git remote.');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(useNetworkSidebarStore.getState().links).toEqual([['p1', REMOTE]]);
    await waitFor(() => expect(screen.queryByTestId('link-suggestion')).not.toBeInTheDocument());
  });

  it('Keep separate never asks again, and changes nothing else', async () => {
    render(<LinkSuggestionLine />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep separate' }));
    await waitFor(() => expect(screen.queryByTestId('link-suggestion')).not.toBeInTheDocument());
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
  });

  it('in project settings: the suggestion, linking any other project by hand, and unlinking', async () => {
    render(<LinkedProjectsSection projectId="p1" />);
    expect(await screen.findByTestId('linked-project-suggestion')).toHaveTextContent('Site on Studio');
    fireEvent.change(screen.getByLabelText('Link with another project'), { target: { value: 'p2' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' }).at(-1)!);
    expect(useNetworkSidebarStore.getState().links).toEqual([['p1', 'p2']]);
    expect(screen.getByTestId('linked-project')).toHaveTextContent('Docs on this computer');
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
    // Only the display changed: both projects are still here.
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('leaves out a computer that was unpaired, though its list is still in memory', async () => {
    useAnnexClientStore.setState({ satellites: [] } as never);
    const { container } = render(<><LinkSuggestionLine /><LinkedProjectsSection projectId="p1" /></>);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
  });

  it('names a linked project whose computer isn\'t connected, never by its id', () => {
    useAnnexClientStore.setState({ satellites: [{ id: 'cc', alias: 'Laptop', state: 'disconnected' }] } as never);
    useNetworkSidebarStore.getState().link('p1', 'remote||cc||gone');
    render(<LinkedProjectsSection projectId="p1" />);
    expect(screen.getByTestId('linked-project')).toHaveTextContent('A project on a computer not connected now');
    expect(screen.getByTestId('linked-project')).not.toHaveTextContent('remote||');
  });

  it('shows a failed shared link save and retries without resending links on display changes', async () => {
    const view = { revision: 1, links: [['p1', REMOTE]], keptSeparate: [] };
    const save = vi.fn().mockRejectedValueOnce(new Error('EBUSY: settings busy')).mockResolvedValue(view);
    window.clubhouse.project.hydrateProjectLinks = vi.fn().mockResolvedValue({ ...view, revision: 0, links: [] });
    window.clubhouse.project.onProjectLinksChanged = vi.fn(() => () => {});
    window.clubhouse.project.changeProjectLinks = save;
    render(<LinkedProjectsSection projectId="p1" />);
    fireEvent.click((await screen.findByTestId('linked-project-suggestion')).querySelector('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save project links');
    useNetworkSidebarStore.getState().setShow('all');
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(save).toHaveBeenLastCalledWith({ type: 'link', a: 'p1', b: REMOTE });
    delete (window.clubhouse.project as Partial<typeof window.clubhouse.project>).hydrateProjectLinks;
  });

  it('shows a permanently rejected edit without a retry and restores the authoritative links', async () => {
    window.clubhouse.project.hydrateProjectLinks = vi.fn().mockResolvedValue({ revision: 0, links: [], keptSeparate: [] });
    window.clubhouse.project.onProjectLinksChanged = vi.fn(() => () => {});
    window.clubhouse.project.changeProjectLinks = vi.fn().mockRejectedValue(new Error('Invalid project reference.'));
    render(<LinkedProjectsSection projectId="p1" />);
    fireEvent.click((await screen.findByTestId('linked-project-suggestion')).querySelector('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save project links');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
    delete (window.clubhouse.project as Partial<typeof window.clubhouse.project>).hydrateProjectLinks;
  });

  it('keeps sidebar link actions reachable after a permanent rejection', async () => {
    window.clubhouse.project.hydrateProjectLinks = vi.fn().mockResolvedValue({ revision: 0, links: [], keptSeparate: [] });
    window.clubhouse.project.onProjectLinksChanged = vi.fn(() => () => {});
    window.clubhouse.project.changeProjectLinks = vi.fn().mockRejectedValue(new Error('Invalid project reference.'));
    render(<LinkSuggestionLine />);
    fireEvent.click(await screen.findByRole('button', { name: 'Link', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save project links');
    expect(screen.getByRole('button', { name: 'Link', exact: true })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    delete (window.clubhouse.project as Partial<typeof window.clubhouse.project>).hydrateProjectLinks;
  });

  it('shows nothing without another computer or a link', () => {
    useRemoteProjectStore.setState({ satelliteProjects: {} } as never);
    const { container } = render(<LinkedProjectsSection projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('suggests a newly visible remote when a later snapshot supplies its key in both surfaces (#3703)', async () => {
    const remote = useRemoteProjectStore.getState().satelliteProjects.bb[0];
    useRemoteProjectStore.setState({ satelliteProjects: { bb: [{ ...remote, repoKey: undefined }] } });
    render(<><LinkSuggestionLine /><LinkedProjectsSection projectId="p1" /></>);
    await waitFor(() => expect(window.clubhouse.project.getRepoKeys).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('link-suggestion')).not.toBeInTheDocument();
    expect(screen.queryByTestId('linked-project-suggestion')).not.toBeInTheDocument();

    act(() => useRemoteProjectStore.setState({ satelliteProjects: { bb: [remote] } }));

    expect(await screen.findByTestId('link-suggestion')).toHaveTextContent('Site is also on Studio');
    expect(await screen.findByTestId('linked-project-suggestion')).toHaveTextContent('Site on Studio');
    expect(window.clubhouse.project.getRepoKeys).toHaveBeenCalledTimes(2);
  });

  it('distinguishes repeated names by computer and path, previews the choice, then shows the linked result', async () => {
    useAnnexClientStore.setState({ satellites: [
      { id: 'bb', alias: 'Studio', fingerprint: 'bb', state: 'connected' },
      { id: 'cc', alias: 'Laptop', fingerprint: 'cc', state: 'connected' },
    ] } as never);
    const other = 'remote||cc||site';
    useRemoteProjectStore.setState({ satelliteProjects: {
      ...useRemoteProjectStore.getState().satelliteProjects,
      cc: [{ id: other, name: 'Site', path: '/work/site', remote: true, satelliteId: 'cc', satelliteName: '' }],
    } });
    render(<LinkedProjectsSection projectId="p1" />);
    expect(screen.getByRole('option', { name: 'Site on Studio (/srv/site)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Site on Laptop (/work/site)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Link with another project'), { target: { value: other } });
    expect(screen.getByRole('status')).toHaveTextContent('Link Site with Site on Laptop');
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link', exact: true }).at(-1)!);
    expect(screen.getByTestId('linked-project')).toHaveTextContent('Site on Laptop');
    expect(screen.getByTestId('linked-project')).toHaveTextContent('/work/site');
    expect(screen.getByLabelText('Link with another project')).toHaveValue('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('invalidates a manual choice when the remote disappears or becomes linked elsewhere', () => {
    render(<LinkedProjectsSection projectId="p1" />);
    const select = screen.getByLabelText('Link with another project');
    const remote = useRemoteProjectStore.getState().satelliteProjects.bb;
    fireEvent.change(select, { target: { value: REMOTE } });
    act(() => useRemoteProjectStore.setState({ satelliteProjects: { bb: [{ ...remote[0], id: 'remote||bb||other' }] } }));
    act(() => useRemoteProjectStore.setState({ satelliteProjects: { bb: remote } }));
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: REMOTE } });
    act(() => useNetworkSidebarStore.getState().link('p1', REMOTE));
    expect(select).toHaveValue('');
    expect(screen.getAllByRole('button', { name: 'Link', exact: true }).at(-1)).toBeDisabled();
  });

  it('does not carry a manual choice into another source project', () => {
    const { rerender } = render(<LinkedProjectsSection projectId="p1" />);
    fireEvent.change(screen.getByLabelText('Link with another project'), { target: { value: REMOTE } });
    rerender(<LinkedProjectsSection projectId="p2" />);
    expect(screen.getByLabelText('Link with another project')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Link', exact: true })).toBeDisabled();
    rerender(<LinkedProjectsSection projectId="p1" />);
    expect(screen.getByLabelText('Link with another project')).toHaveValue('');
  });

  it('reverses Keep separate from the sidebar in settings, and can link again after unlinking', async () => {
    render(<><LinkSuggestionLine /><LinkedProjectsSection projectId="p1" /></>);
    fireEvent.click(within(await screen.findByTestId('link-suggestion')).getByRole('button', { name: 'Keep separate' }));
    expect(screen.queryByTestId('linked-project-suggestion')).not.toBeInTheDocument();
    const separated = screen.getByTestId('kept-separate-project');
    expect(separated).toHaveTextContent('Site on Studio');
    fireEvent.click(within(separated).getByRole('button', { name: 'Link instead' }));
    expect(useNetworkSidebarStore.getState().links).toEqual([['p1', REMOTE]]);
    expect(useNetworkSidebarStore.getState().keptSeparate).toEqual([]);
    expect(screen.getByTestId('linked-project')).toHaveTextContent('stop link suggestions');
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(useNetworkSidebarStore.getState().links).toEqual([]);
    expect(screen.queryByTestId('link-suggestion')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Link instead' }));
    expect(useNetworkSidebarStore.getState().links).toEqual([['p1', REMOTE]]);
    expect(useNetworkSidebarStore.getState().keptSeparate).toEqual([]);
  });

  it('names both projects in the sidebar when matching repositories have different folder names', async () => {
    const remote = useRemoteProjectStore.getState().satelliteProjects.bb[0];
    useRemoteProjectStore.setState({ satelliteProjects: { bb: [{ ...remote, displayName: 'Website' }] } });
    render(<LinkSuggestionLine />);
    expect(await screen.findByTestId('link-suggestion')).toHaveTextContent('Site and Website on Studio share the same git remote.');
    expect(screen.getByTestId('link-suggestion')).toHaveTextContent('project settings under Linked projects');
  });
});
