import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutSettingsView } from './AboutSettingsView';

// Mock the manifest-validator module
vi.mock('../../plugins/manifest-validator', () => ({
  SUPPORTED_API_VERSIONS: ['0.5'],
}));

// Set up window.clubhouse mock
const mockGetVersion = vi.fn().mockResolvedValue('1.2.3');
const mockGetArchInfo = vi.fn().mockResolvedValue({ arch: 'arm64', platform: 'darwin', rosetta: false });

(window as any).clubhouse = {
  app: {
    getVersion: mockGetVersion,
    getArchInfo: mockGetArchInfo,
  },
};

describe('AboutSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockResolvedValue('1.2.3');
    mockGetArchInfo.mockResolvedValue({ arch: 'arm64', platform: 'darwin', rosetta: false });
  });

  it('renders version', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText(/1\.2\.3/)).toBeTruthy();
  });

  it('renders architecture for arm64', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText('arm64')).toBeTruthy();
  });

  it('renders Rosetta warning when running under translation', async () => {
    mockGetArchInfo.mockResolvedValue({
      arch: 'x64',
      platform: 'darwin',
      rosetta: true,
    });
    render(<AboutSettingsView />);
    expect(await screen.findByText('x64 (Rosetta)')).toBeTruthy();
    expect(await screen.findByText(/running under Rosetta translation/)).toBeTruthy();
  });

  it('does not show Rosetta warning for native x64', async () => {
    mockGetArchInfo.mockResolvedValue({
      arch: 'x64',
      platform: 'darwin',
      rosetta: false,
    });
    render(<AboutSettingsView />);
    expect(await screen.findByText('x64')).toBeTruthy();
    expect(screen.queryByText(/Rosetta/)).toBeNull();
  });

  it('renders plugin API versions', async () => {
    render(<AboutSettingsView />);
    expect(await screen.findByText('0.5')).toBeTruthy();
  });
});
