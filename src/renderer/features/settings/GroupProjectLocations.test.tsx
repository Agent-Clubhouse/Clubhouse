import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ lookup: vi.fn(), open: vi.fn() }));
vi.mock('../agents/helpers/connection-target-navigation', () => ({ lookupConnectionCanvases: nav.lookup, jumpToConnectionCanvas: nav.open }));
import { GroupProjectLocations } from './GroupProjectLocations';

const hit = { scope: 'app', canvasId: 'one', name: 'Canvas One', viewId: 'card', nodeName: 'Group' };
beforeEach(() => {
  vi.resetAllMocks();
  nav.lookup.mockResolvedValue({ hits: [hit] });
  nav.open.mockResolvedValue(undefined);
  vi.spyOn(window.clubhouse.groupProject, 'getAllMessages').mockResolvedValue([{ id: 'msg', sender: 'Ada', topic: 'plans', body: 'Hello', timestamp: 'now' }]);
});

describe('group project locations', () => {
  it('shows board messages and opens a selected canvas', async () => {
    render(<GroupProjectLocations id="gp" />);
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Home / Canvas One' }));
    await waitFor(() => expect(nav.open).toHaveBeenCalledWith('group-project', 'gp', hit, expect.any(AbortSignal)));
  });

  it('reports an incomplete canvas inventory rather than an empty list', async () => {
    nav.lookup.mockRejectedValue(new Error('Canvas lookup is incomplete'));
    render(<GroupProjectLocations id="gp" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Canvas lookup is incomplete');
    expect(screen.queryByText('This group project is not on a canvas.')).not.toBeInTheDocument();
  });
});
