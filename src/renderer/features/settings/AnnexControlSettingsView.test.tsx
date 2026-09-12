import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnnexControlSettingsView } from './AnnexControlSettingsView';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';

const mockForgetAllSatellites = vi.fn();
const mockSaveAnnexSettings = vi.fn();
const mockLoadSatellites = vi.fn();
const mockLoadAnnexSettings = vi.fn();
const mockScan = vi.fn();

function resetStores() {
  useAnnexClientStore.setState({
    satellites: [],
    loadSatellites: mockLoadSatellites,
    scan: mockScan,
    forgetAllSatellites: mockForgetAllSatellites,
    disconnect: vi.fn(),
    retry: vi.fn(),
    forgetSatellite: vi.fn(),
    connect: vi.fn(),
    pairWith: vi.fn(),
    getDiscovered: vi.fn().mockResolvedValue([]),
    discoveredServices: [],
    loadDiscovered: vi.fn(),
  });

  useAnnexStore.setState({
    settings: { enableClient: false, enableServer: false, deviceName: 'Test Device' },
    status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
    saveSettings: mockSaveAnnexSettings,
    loadSettings: mockLoadAnnexSettings,
    loadStatus: vi.fn(),
    regeneratePin: vi.fn(),
  });
}

describe('AnnexControlSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<AnnexControlSettingsView />);
    expect(screen.getByText('Annex Control')).toBeInTheDocument();
  });

  it('calls loadSatellites and loadAnnexSettings on mount', () => {
    render(<AnnexControlSettingsView />);
    expect(mockLoadSatellites).toHaveBeenCalled();
    expect(mockLoadAnnexSettings).toHaveBeenCalled();
  });

  describe('enableClient toggle', () => {
    it('renders toggle control', () => {
      render(<AnnexControlSettingsView />);
      expect(screen.getByTestId('annex-client-toggle')).toBeInTheDocument();
    });

    it('toggles enableClient setting to true', () => {
      render(<AnnexControlSettingsView />);
      const toggleContainer = screen.getByTestId('annex-client-toggle');
      const toggle = toggleContainer.querySelector('button');
      if (toggle) fireEvent.click(toggle);
      expect(mockSaveAnnexSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enableClient: true })
      );
    });

    it('toggles enableClient setting to false', () => {
      useAnnexStore.setState({
        settings: { enableClient: true, enableServer: false, deviceName: 'Test Device' },
      });
      render(<AnnexControlSettingsView />);
      const toggleContainer = screen.getByTestId('annex-client-toggle');
      const toggle = toggleContainer.querySelector('button');
      if (toggle) fireEvent.click(toggle);
      expect(mockSaveAnnexSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enableClient: false })
      );
    });
  });

  describe('purge flow', () => {
    it('shows "Forget All Satellites" button initially', () => {
      render(<AnnexControlSettingsView />);
      expect(screen.getByRole('button', { name: 'Forget All Satellites' })).toBeInTheDocument();
    });

    it('shows confirmation buttons when forget button clicked', () => {
      render(<AnnexControlSettingsView />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget All Satellites' }));
      expect(screen.getByRole('button', { name: 'Confirm Reset' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('calls forgetAllSatellites when confirm clicked', () => {
      render(<AnnexControlSettingsView />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget All Satellites' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Reset' }));
      expect(mockForgetAllSatellites).toHaveBeenCalledTimes(1);
    });

    it('hides confirmation after confirm clicked', async () => {
      render(<AnnexControlSettingsView />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget All Satellites' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Reset' }));
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Confirm Reset' })).not.toBeInTheDocument();
      });
    });

    it('cancels confirmation when cancel clicked', () => {
      render(<AnnexControlSettingsView />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget All Satellites' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(mockForgetAllSatellites).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Forget All Satellites' })).toBeInTheDocument();
    });

    it('protects against rapid double-click of forgetAllSatellites', () => {
      render(<AnnexControlSettingsView />);
      const forgetBtn = screen.getByRole('button', { name: 'Forget All Satellites' });
      const confirmBtn = () => screen.queryByRole('button', { name: 'Confirm Reset' });
      
      // First click - show confirmation
      fireEvent.click(forgetBtn);
      expect(confirmBtn()).toBeInTheDocument();

      // Rapid double-click on confirm button
      const confirmElement = screen.getByRole('button', { name: 'Confirm Reset' });
      fireEvent.click(confirmElement);
      fireEvent.click(confirmElement);

      // forgetAllSatellites should be called exactly once despite double-click
      expect(mockForgetAllSatellites).toHaveBeenCalledTimes(1);
    });
  });

  describe('paired satellites section', () => {
    it('shows "Paired Satellites" heading', () => {
      render(<AnnexControlSettingsView />);
      expect(screen.getByText('Paired Satellites')).toBeInTheDocument();
    });

    it('shows "Add Satellite" and "Scan" buttons', () => {
      render(<AnnexControlSettingsView />);
      expect(screen.getByRole('button', { name: 'Add Satellite' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    });

    it('shows empty state when no satellites', () => {
      render(<AnnexControlSettingsView />);
      expect(screen.getByText(/No paired satellites/)).toBeInTheDocument();
    });

    it('calls scan when Scan button clicked', () => {
      render(<AnnexControlSettingsView />);
      fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
      expect(mockScan).toHaveBeenCalled();
    });

    it('toggles pairing wizard visibility', () => {
      render(<AnnexControlSettingsView />);
      const addBtn = screen.getByRole('button', { name: 'Add Satellite' });
      fireEvent.click(addBtn);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      fireEvent.click(addBtn);
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });
  });
});
