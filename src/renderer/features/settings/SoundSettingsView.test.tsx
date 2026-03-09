import { render, screen } from '@testing-library/react';
import { SoundSettingsView } from './SoundSettingsView';
import { useSoundStore } from '../../stores/soundStore';

const mockLoadSettings = vi.fn();
const mockLoadPacks = vi.fn();
const mockSaveSettings = vi.fn();
const mockImportPack = vi.fn();
const mockDeletePack = vi.fn();
const mockApplyAllFromPack = vi.fn();
const mockPreviewSound = vi.fn();

function resetStores(overrides: Record<string, any> = {}) {
  useSoundStore.setState({
    settings: {
      activePack: null,
      slotAssignments: {},
      eventSettings: {
        'agent-complete': { enabled: true, volume: 80 },
        'agent-error': { enabled: true, volume: 80 },
        'agent-needs-input': { enabled: true, volume: 80 },
      },
      projectOverrides: {},
    },
    packs: [
      {
        id: 'default-pack',
        name: 'Default Pack',
        source: 'builtin' as any,
        sounds: { 'agent-complete': 'ding.wav' } as any,
      },
    ],
    soundCache: {},
    loadSettings: mockLoadSettings,
    loadPacks: mockLoadPacks,
    saveSettings: mockSaveSettings,
    importPack: mockImportPack,
    deletePack: mockDeletePack,
    applyAllFromPack: mockApplyAllFromPack,
    previewSound: mockPreviewSound,
    playSound: vi.fn(),
    ...overrides,
  });
}

describe('SoundSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<SoundSettingsView />);
    expect(screen.getByText('Sounds')).toBeInTheDocument();
  });

  it('shows loading state when settings are null', () => {
    resetStores({ settings: null });
    render(<SoundSettingsView />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('calls loadSettings and loadPacks on mount', () => {
    render(<SoundSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
    expect(mockLoadPacks).toHaveBeenCalled();
  });

  it('renders event sounds section', () => {
    render(<SoundSettingsView />);
    expect(screen.getByText('Event Sounds')).toBeInTheDocument();
  });

  it('renders sound packs section', () => {
    render(<SoundSettingsView />);
    expect(screen.getByText('Sound Packs')).toBeInTheDocument();
    expect(screen.getByText('Default Pack')).toBeInTheDocument();
  });

  it('shows import button', () => {
    render(<SoundSettingsView />);
    expect(screen.getByText('Import Sound Pack...')).toBeInTheDocument();
  });

  it('shows empty packs message when no packs', () => {
    resetStores({ packs: [] });
    render(<SoundSettingsView />);
    expect(screen.getByText('No sound packs installed. Import one to get started.')).toBeInTheDocument();
  });

  it('renders project override section when projectId provided', () => {
    render(<SoundSettingsView projectId="proj-1" />);
    expect(screen.getByText('Sound Pack Override')).toBeInTheDocument();
  });

  it('shows "Apply All" button for packs', () => {
    render(<SoundSettingsView />);
    expect(screen.getByText('Apply All')).toBeInTheDocument();
  });
});
