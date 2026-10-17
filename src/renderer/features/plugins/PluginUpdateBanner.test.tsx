import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';
import { PluginUpdateBanner } from './PluginUpdateBanner';

type Update = ReturnType<typeof usePluginUpdateStore.getState>['updates'][number];
type Incompatible = ReturnType<typeof usePluginUpdateStore.getState>['incompatibleUpdates'][number];
const update = (id: string, name: string, v: string) => ({ pluginId: id, pluginName: name, latestVersion: v }) as unknown as Update;

describe('PluginUpdateBanner card variant (new chrome)', () => {
  const updatePlugin = vi.fn();
  const updateAll = vi.fn();
  const dismiss = vi.fn();
  beforeEach(() => {
    usePluginUpdateStore.setState({
      updates: [], incompatibleUpdates: [], dismissed: false, updating: {}, updateErrors: {},
      updatePlugin, updateAll, dismiss,
    });
  });

  it('renders nothing without updates', () => {
    const { container } = render(<PluginUpdateBanner variant="card" />);
    expect(container.innerHTML).toBe('');
  });

  it('offers one update with Update and Later', () => {
    usePluginUpdateStore.setState({ updates: [update('p1', 'Goobers', '1.2.0')] });
    render(<PluginUpdateBanner variant="card" />);
    const card = screen.getByTestId('plugin-update-banner');
    expect(card).toHaveTextContent('Plugin update');
    expect(card).toHaveTextContent('v1.2.0');
    expect(screen.getByTestId('plugin-update-message')).toHaveTextContent('Goobers');
    fireEvent.click(screen.getByTestId('plugin-update-btn'));
    expect(updatePlugin).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByTestId('plugin-update-dismiss-btn'));
    expect(dismiss).toHaveBeenCalled();
  });

  it('updates all of several, and shows Updating while busy', () => {
    usePluginUpdateStore.setState({ updates: [update('p1', 'A', '1'), update('p2', 'B', '2')], updating: { p1: 'downloading' } });
    render(<PluginUpdateBanner variant="card" />);
    expect(screen.getByTestId('plugin-update-banner')).toHaveTextContent('2 plugin updates');
    const btn = screen.getByTestId('plugin-update-btn');
    expect(btn).toHaveTextContent('Updating');
    expect(btn).toBeDisabled();
  });

  it('shows the reload failure card', () => {
    usePluginUpdateStore.setState({ updateErrors: { p1: 'boom' } });
    render(<PluginUpdateBanner variant="card" />);
    expect(screen.getByTestId('plugin-update-banner')).toHaveTextContent('Plugin reload failed');
  });

  it('shows the needs-a-newer-Clubhouse card', () => {
    usePluginUpdateStore.setState({
      incompatibleUpdates: [{ pluginId: 'p1', pluginName: 'Goobers', latestVersion: '2.0.0', requiredApi: 0.9 } as unknown as Incompatible],
    });
    render(<PluginUpdateBanner variant="card" />);
    expect(screen.getByTestId('plugin-update-banner')).toHaveTextContent('needs a newer Clubhouse');
    expect(screen.getByTestId('plugin-update-message')).toHaveTextContent('Goobers v2.0.0 requires API 0.9');
  });
});
