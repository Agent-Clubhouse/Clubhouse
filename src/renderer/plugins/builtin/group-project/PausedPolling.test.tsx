import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PausedPolling } from './GroupProjectCanvasWidget';

let changed: (() => void) | null;

beforeEach(() => {
  changed = null;
  window.clubhouse.groupProject.onPausedPollingChanged = vi.fn((cb) => { changed = cb; return () => { changed = null; }; });
  window.clubhouse.groupProject.getPausedPolling = vi.fn(async () => []);
  window.clubhouse.groupProject.resumePolling = vi.fn(async () => true);
});

describe('PausedPolling', () => {
  it('shows nothing with no member offered', async () => {
    const { container } = render(<PausedPolling groupProjectId="gp" />);
    await waitFor(() => expect(window.clubhouse.groupProject.getPausedPolling).toHaveBeenCalledWith('gp'));
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Resume for a paused member, sends it, and goes when main says so', async () => {
    window.clubhouse.groupProject.getPausedPolling = vi.fn().mockResolvedValueOnce([{ agentId: 'a1', agentName: 'runner' }]).mockResolvedValue([]);
    render(<PausedPolling groupProjectId="gp" />);
    expect(await screen.findByText('runner: polling paused')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('polling-resume-a1')); });
    expect(window.clubhouse.groupProject.resumePolling).toHaveBeenCalledWith('gp', 'a1');
    await waitFor(() => expect(screen.queryByTestId('polling-paused')).toBeNull());
  });

  it('reads again when the members offered change', async () => {
    render(<PausedPolling groupProjectId="gp" />);
    await waitFor(() => expect(changed).toBeTruthy());
    window.clubhouse.groupProject.getPausedPolling = vi.fn(async () => [{ agentId: 'a2', agentName: 'walker' }]);
    act(() => changed?.());
    expect(await screen.findByText('walker: polling paused')).toBeInTheDocument();
  });

  it('stops listening when it goes', async () => {
    const { unmount } = render(<PausedPolling groupProjectId="gp" />);
    await waitFor(() => expect(changed).toBeTruthy());
    unmount();
    expect(changed).toBeNull();
  });
});
