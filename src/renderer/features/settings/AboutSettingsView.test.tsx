import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutSettingsView } from './AboutSettingsView';

// Mock the marketplace types module
vi.mock('../../../shared/marketplace-types', () => ({
  SUPPORTED_PLUGIN_API_VERSIONS: ['0.5'],
}));

// Set up window.clubhouse mock
const mockGetVersion = vi.fn().mockResolvedValue('1.2.3');
const mockGetArchInfo = vi.fn().mockResolvedValue({ arch: 'arm64', platform: 'darwin', rosetta: false });
const mockGetCliStatus = vi.fn().mockResolvedValue({ supported: false, installed: false });
const mockInstallCli = vi.fn();
const mockUninstallCli = vi.fn();

(window as any).clubhouse = {
  app: {
    getVersion: mockGetVersion,
    getArchInfo: mockGetArchInfo,
    getCliInstallStatus: mockGetCliStatus,
    installCli: mockInstallCli,
    uninstallCli: mockUninstallCli,
  },
};

describe('AboutSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockResolvedValue('1.2.3');
    mockGetArchInfo.mockResolvedValue({ arch: 'arm64', platform: 'darwin', rosetta: false });
    mockGetCliStatus.mockResolvedValue({ supported: false, installed: false });
  });

  it('renders version', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText(/1\.2\.3/)).toBeInTheDocument();
  });

  it('renders architecture for arm64', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText('arm64')).toBeInTheDocument();
  });

  it('renders Rosetta warning when running under translation', async () => {
    mockGetArchInfo.mockResolvedValue({
      arch: 'x64',
      platform: 'darwin',
      rosetta: true,
    });
    render(<AboutSettingsView />);
    expect(await screen.findByText('x64 (Rosetta)')).toBeInTheDocument();
    expect(await screen.findByText(/running under Rosetta translation/)).toBeInTheDocument();
  });

  it('does not show Rosetta warning for native x64', async () => {
    mockGetArchInfo.mockResolvedValue({
      arch: 'x64',
      platform: 'darwin',
      rosetta: false,
    });
    render(<AboutSettingsView />);
    expect(await screen.findByText('x64')).toBeInTheDocument();
    expect(screen.queryByText(/Rosetta/)).toBeNull();
  });

  it('renders plugin API versions', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText('0.5')).toBeInTheDocument();
  });

  describe('command line tool', () => {
    it('stays hidden where it can\'t be installed', async () => {
      render(<AboutSettingsView />);
      await screen.findByText('Clubhouse v1.2.3');
      expect(screen.queryByTestId('cli-install')).toBeNull();
    });

    it('installs, then shows where and what is left to do', async () => {
      mockGetCliStatus.mockResolvedValue({ supported: true, installed: false });
      mockInstallCli.mockResolvedValue({ supported: true, installed: true, commandPath: '/x/clubhouse', note: 'Add /x to your PATH to use the clubhouse command.' });
      render(<AboutSettingsView />);
      fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
      expect(await screen.findByText('Add /x to your PATH to use the clubhouse command.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    });

    it('removes it, and shows why if that fails', async () => {
      mockGetCliStatus.mockResolvedValue({ supported: true, installed: true, commandPath: '/x/clubhouse' });
      mockUninstallCli.mockRejectedValue(new Error('No permission'));
      render(<AboutSettingsView />);
      expect(await screen.findByText('/x/clubhouse')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(screen.getByText('No permission')).toBeInTheDocument());
    });
  });
});
