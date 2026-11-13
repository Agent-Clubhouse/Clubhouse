import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { GroupProjectDeliverySection } from './GroupProjectDeliverySection';

const project = (metadata: Record<string, unknown>): GroupProject => ({
  id: 'gp1', name: 'Release', description: '', instructions: '', createdAt: '2026-11-13T00:00:00Z', metadata,
});

describe('GroupProjectDeliverySection', () => {
  beforeEach(() => {
    useGroupProjectStore.setState({ projects: [project({})], loaded: true, loadError: null });
  });

  it('describes notices for a group project without polling', () => {
    render(<GroupProjectDeliverySection groupProjectId="gp1" />);
    expect(screen.getByText(/one notice per burst of posts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to notices' })).not.toBeInTheDocument();
  });

  it('offers a group project that still polls to switch to notices', async () => {
    useGroupProjectStore.setState({ projects: [project({ pollingEnabled: true })] });
    const setPolling = vi.fn(async () => undefined);
    useGroupProjectStore.setState({ setPolling });
    render(<GroupProjectDeliverySection groupProjectId="gp1" />);
    expect(screen.getByText(/still uses polling/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to notices' }));
    expect(setPolling).toHaveBeenCalledWith('gp1', false);
  });
});
