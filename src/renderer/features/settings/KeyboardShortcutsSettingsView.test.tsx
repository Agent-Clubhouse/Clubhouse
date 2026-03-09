import { render, screen, fireEvent } from '@testing-library/react';
import { KeyboardShortcutsSettingsView } from './KeyboardShortcutsSettingsView';
import { useKeyboardShortcutsStore } from '../../stores/keyboardShortcutsStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';

const EMPTY_PLUGIN_SHORTCUTS: any[] = [];

vi.mock('../../plugins/plugin-hotkeys', () => ({
  pluginHotkeyRegistry: {
    getAll: () => EMPTY_PLUGIN_SHORTCUTS,
    onChange: () => ({ dispose: vi.fn() }),
    setBinding: vi.fn(),
    resetBinding: vi.fn(),
  },
}));

const mockResetAll = vi.fn();
const mockStartEditing = vi.fn();
const mockStopEditing = vi.fn();
const mockSetBinding = vi.fn();
const mockResetBinding = vi.fn();
const mockLoadClipboard = vi.fn();
const mockSaveClipboard = vi.fn();

function resetStores() {
  useKeyboardShortcutsStore.setState({
    shortcuts: {
      'command-palette': {
        id: 'command-palette',
        label: 'Command Palette',
        category: 'General',
        defaultBinding: 'Meta+K',
        currentBinding: 'Meta+K',
      },
      'toggle-settings': {
        id: 'toggle-settings',
        label: 'Toggle Settings',
        category: 'General',
        defaultBinding: 'Meta+,',
        currentBinding: 'Meta+,',
      },
      'focus-chat': {
        id: 'focus-chat',
        label: 'Focus Chat',
        category: 'Navigation',
        defaultBinding: 'Meta+L',
        currentBinding: 'Meta+L',
      },
    },
    editingId: null,
    resetAll: mockResetAll,
    startEditing: mockStartEditing,
    stopEditing: mockStopEditing,
    setBinding: mockSetBinding,
    resetBinding: mockResetBinding,
  });

  usePluginStore.setState({
    plugins: {},
    modules: {},
  });

  useClipboardSettingsStore.setState({
    clipboardCompat: false,
    loaded: true,
    loadSettings: mockLoadClipboard,
    saveSettings: mockSaveClipboard,
  });
}

describe('KeyboardShortcutsSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('groups shortcuts by category', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
  });

  it('shows shortcut labels', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(screen.getByText('Command Palette')).toBeInTheDocument();
    expect(screen.getByText('Toggle Settings')).toBeInTheDocument();
    expect(screen.getByText('Focus Chat')).toBeInTheDocument();
  });

  it('shows clipboard compatibility toggle', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(screen.getByText('Enable Clipboard Compatibility')).toBeInTheDocument();
  });

  it('hides Reset All button when no overrides exist', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(screen.queryByText('Reset All to Defaults')).not.toBeInTheDocument();
  });

  it('shows Reset All button when an override exists', () => {
    useKeyboardShortcutsStore.setState({
      shortcuts: {
        'command-palette': {
          id: 'command-palette',
          label: 'Command Palette',
          category: 'General',
          defaultBinding: 'Meta+K',
          currentBinding: 'Meta+P', // modified
        },
      },
    });

    render(<KeyboardShortcutsSettingsView />);
    expect(screen.getByText('Reset All to Defaults')).toBeInTheDocument();
  });

  it('calls resetAll when Reset All button clicked', () => {
    useKeyboardShortcutsStore.setState({
      shortcuts: {
        'command-palette': {
          id: 'command-palette',
          label: 'Command Palette',
          category: 'General',
          defaultBinding: 'Meta+K',
          currentBinding: 'Meta+P',
        },
      },
    });

    render(<KeyboardShortcutsSettingsView />);
    fireEvent.click(screen.getByText('Reset All to Defaults'));
    expect(mockResetAll).toHaveBeenCalled();
  });

  it('loads clipboard settings on mount', () => {
    render(<KeyboardShortcutsSettingsView />);
    expect(mockLoadClipboard).toHaveBeenCalled();
  });
});
