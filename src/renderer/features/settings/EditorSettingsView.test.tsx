import { render, screen, fireEvent } from '@testing-library/react';
import { EditorSettingsView } from './EditorSettingsView';
import { useEditorSettingsStore } from '../../stores/editorSettingsStore';

const mockLoadSettings = vi.fn();
const mockSaveSettings = vi.fn();

function resetStore(overrides: Partial<{
  editorCommand: string;
  editorName: string;
  loaded: boolean;
}> = {}) {
  useEditorSettingsStore.setState({
    editorCommand: 'code',
    editorName: 'VS Code',
    loaded: true,
    loadSettings: mockLoadSettings,
    saveSettings: mockSaveSettings,
    ...overrides,
  });
}

describe('EditorSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('renders heading and description', () => {
    render(<EditorSettingsView />);
    expect(screen.getByText('External Editor')).toBeInTheDocument();
    expect(screen.getByText(/Choose which editor/)).toBeInTheDocument();
  });

  it('loads settings on mount', () => {
    render(<EditorSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
  });

  it('renders editor presets', () => {
    render(<EditorSettingsView />);
    expect(screen.getByText('VS Code')).toBeInTheDocument();
    expect(screen.getByText('Cursor')).toBeInTheDocument();
    expect(screen.getByText('Zed')).toBeInTheDocument();
    expect(screen.getByText('Sublime Text')).toBeInTheDocument();
  });

  it('highlights the currently selected preset', () => {
    resetStore({ editorCommand: 'cursor', editorName: 'Cursor' });
    render(<EditorSettingsView />);
    const cursorBtn = screen.getByTestId('editor-preset-cursor');
    expect(cursorBtn.className).toContain('border-ctp-accent');
  });

  it('saves settings when a preset is clicked', () => {
    render(<EditorSettingsView />);
    fireEvent.click(screen.getByTestId('editor-preset-zed'));
    expect(mockSaveSettings).toHaveBeenCalledWith({
      editorCommand: 'zed',
      editorName: 'Zed',
    });
  });

  it('shows current editor command and name', () => {
    render(<EditorSettingsView />);
    const status = screen.getByText(/Currently using:/);
    expect(status).toBeInTheDocument();
    expect(status.textContent).toContain('code');
    expect(status.textContent).toContain('VS Code');
  });

  it('renders custom command input', () => {
    render(<EditorSettingsView />);
    expect(screen.getByTestId('editor-custom-command')).toBeInTheDocument();
  });

  it('saves custom command on input change', () => {
    render(<EditorSettingsView />);
    const input = screen.getByTestId('editor-custom-command');
    fireEvent.change(input, { target: { value: 'my-editor' } });
    expect(mockSaveSettings).toHaveBeenCalledWith({
      editorCommand: 'my-editor',
      editorName: 'my-editor',
    });
  });

  it('does not save when custom command is empty', () => {
    render(<EditorSettingsView />);
    const input = screen.getByTestId('editor-custom-command');
    fireEvent.change(input, { target: { value: '  ' } });
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });
});
