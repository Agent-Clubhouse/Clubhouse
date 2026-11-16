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
});

describe('group project locations', () => {
  it('opens a selected canvas, and says a canvas is optional', async () => {
    render(<GroupProjectLocations id="gp" />);
    expect(await screen.findByText(/Removing a canvas card keeps this group project and its members/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Home / Canvas One' }));
    await waitFor(() => expect(nav.open).toHaveBeenCalledWith('group-project', 'gp', hit, expect.any(AbortSignal)));
  });

  it('reports an incomplete canvas inventory rather than an empty list', async () => {
    nav.lookup.mockRejectedValue(new Error('Canvas lookup is incomplete'));
    render(<GroupProjectLocations id="gp" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Canvas lookup is incomplete');
    expect(screen.queryByText(/This group project is not on a canvas/)).not.toBeInTheDocument();
  });

  it('says the group project works without a canvas when none holds it', async () => {
    nav.lookup.mockResolvedValue({ hits: [] });
    render(<GroupProjectLocations id="gp" />);
    expect(await screen.findByText('This group project is not on a canvas. It works without one.')).toBeInTheDocument();
  });
});
