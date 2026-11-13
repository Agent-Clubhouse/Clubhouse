import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    useNetworkSidebarStore.getState().link('p1', 'remote||cc||gone');
    render(<LinkedProjectsSection projectId="p1" />);
    expect(screen.getByTestId('linked-project')).toHaveTextContent('A project on a computer not connected now');
    expect(screen.getByTestId('linked-project')).not.toHaveTextContent('remote||');
  });

  it('shows a failed handoff routing save and retries without resending links on display changes', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    window.clubhouse.project.setHandoffProjectLinks = save;
    render(<LinkedProjectsSection projectId="p1" />);
    fireEvent.click((await screen.findByTestId('linked-project-suggestion')).querySelector('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save project links');
    useNetworkSidebarStore.getState().setShow('all');
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(save).toHaveBeenLastCalledWith([['p1', REMOTE]]);
    window.clubhouse.project.setHandoffProjectLinks = vi.fn().mockResolvedValue(undefined);
  });

  it('shows nothing without another computer or a link', () => {
    useRemoteProjectStore.setState({ satelliteProjects: {} } as never);
    const { container } = render(<LinkedProjectsSection projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
