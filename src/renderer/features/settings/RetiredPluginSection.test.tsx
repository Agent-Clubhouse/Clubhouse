import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetiredPluginSection } from './RetiredPluginSection';

const LOUNGE_DIR = '/home/u/.clubhouse/plugin-data/lounge';

describe('RetiredPluginSection (#2756)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says what replaced Lounge, lists where its data is, and exports it', async () => {
    vi.spyOn(window.clubhouse.plugin, 'findRetiredData').mockResolvedValue({ installed: true, locations: [{ scope: 'global', dir: LOUNGE_DIR }] });
    const exportData = vi.spyOn(window.clubhouse.plugin, 'exportRetiredData').mockResolvedValue({ canceled: false, filePath: '/tmp/lounge-data.json' });

    render(<RetiredPluginSection pluginId="lounge" />);

    expect(screen.getByText(/Lounge was retired in Clubhouse 1.0/)).toHaveTextContent('sidebar project tree and Needs you');
    expect(await screen.findByText(LOUNGE_DIR)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retired-plugin-export'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Exported to /tmp/lounge-data.json.'));
    expect(exportData).toHaveBeenCalledWith('lounge');
  });

  it('says so when the plugin left no data, and offers no export', async () => {
    vi.spyOn(window.clubhouse.plugin, 'findRetiredData').mockResolvedValue({ installed: true, locations: [] });
    render(<RetiredPluginSection pluginId="bug-report" />);
    expect(await screen.findByText('It left no data on this computer.')).toBeInTheDocument();
    expect(screen.queryByTestId('retired-plugin-export')).toBeNull();
  });

  it('shows an export failure', async () => {
    vi.spyOn(window.clubhouse.plugin, 'findRetiredData').mockResolvedValue({ installed: false, locations: [{ scope: 'project-local', projectPath: '/p', dir: '/p/.clubhouse/plugin-data-local/kanboss' }] });
    vi.spyOn(window.clubhouse.plugin, 'exportRetiredData').mockResolvedValue({ canceled: false, filePath: '/tmp/x.json', error: 'EACCES' });
    render(<RetiredPluginSection pluginId="kanboss" />);
    fireEvent.click(await screen.findByTestId('retired-plugin-export'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Couldn't export: EACCES"));
  });
});
