import { render, screen, fireEvent } from '@testing-library/react';
import { ProfilesSettingsView } from './ProfilesSettingsView';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

const mockLoadProfiles = vi.fn();
const mockSaveProfile = vi.fn().mockResolvedValue(undefined);
const mockDeleteProfile = vi.fn().mockResolvedValue(undefined);
const mockLoadOrchestratorSettings = vi.fn();
const mockGetProfileEnvKeys = vi.fn().mockResolvedValue([]);

function resetStores() {
  useProfileStore.setState({
    profiles: [],
    loadProfiles: mockLoadProfiles,
    saveProfile: mockSaveProfile,
    deleteProfile: mockDeleteProfile,
    getProfileEnvKeys: mockGetProfileEnvKeys,
  });

  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: {} as any },
    ],
    loadSettings: mockLoadOrchestratorSettings,
    availability: {},
  });
}

describe('ProfilesSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<ProfilesSettingsView />);
    expect(screen.getByText('Profiles')).toBeInTheDocument();
  });

  it('calls loadProfiles and loadSettings on mount', () => {
    render(<ProfilesSettingsView />);
    expect(mockLoadProfiles).toHaveBeenCalled();
    expect(mockLoadOrchestratorSettings).toHaveBeenCalled();
  });

  it('shows empty state when no profiles', () => {
    render(<ProfilesSettingsView />);
    expect(screen.getByText('No profiles configured yet.')).toBeInTheDocument();
  });

  it('shows New Profile button', () => {
    render(<ProfilesSettingsView />);
    expect(screen.getByText('+ New Profile')).toBeInTheDocument();
  });

  it('renders existing profiles', () => {
    useProfileStore.setState({
      profiles: [
        {
          id: 'profile-1',
          name: 'Work',
          orchestrators: {
            'claude-code': { env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } },
          },
        },
      ],
    });

    render(<ProfilesSettingsView />);
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('shows profile orchestrator names', () => {
    useProfileStore.setState({
      profiles: [
        {
          id: 'profile-1',
          name: 'Work',
          orchestrators: {
            'claude-code': { env: {} },
          },
        },
      ],
    });

    render(<ProfilesSettingsView />);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('shows "No orchestrators" for empty profile', () => {
    useProfileStore.setState({
      profiles: [
        { id: 'profile-1', name: 'Empty', orchestrators: {} },
      ],
    });

    render(<ProfilesSettingsView />);
    expect(screen.getByText('No orchestrators')).toBeInTheDocument();
  });

  it('opens delete confirmation dialog', () => {
    useProfileStore.setState({
      profiles: [
        { id: 'profile-1', name: 'Work', orchestrators: {} },
      ],
    });

    render(<ProfilesSettingsView />);
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete Profile?')).toBeInTheDocument();
  });

  it('cancels delete dialog', () => {
    useProfileStore.setState({
      profiles: [
        { id: 'profile-1', name: 'Work', orchestrators: {} },
      ],
    });

    render(<ProfilesSettingsView />);
    fireEvent.click(screen.getByText('Delete'));
    // Click the Cancel button inside the confirm dialog
    const cancelButtons = screen.getAllByText('Cancel');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByText('Delete Profile?')).not.toBeInTheDocument();
  });

  it('creates a new profile on button click', () => {
    // Mock saveProfile to update the store with the new profile
    const saveFn = vi.fn().mockImplementation((profile: any) => {
      useProfileStore.setState({
        profiles: [...useProfileStore.getState().profiles, profile],
      });
      return Promise.resolve();
    });
    useProfileStore.setState({ saveProfile: saveFn });

    render(<ProfilesSettingsView />);
    fireEvent.click(screen.getByText('+ New Profile'));
    expect(saveFn).toHaveBeenCalled();
    // Edit form should appear with Profile Name label
    expect(screen.getByText('Profile Name')).toBeInTheDocument();
  });

  it('shows usage instructions', () => {
    render(<ProfilesSettingsView />);
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });
});
