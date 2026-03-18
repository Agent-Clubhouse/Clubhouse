import { useEffect } from 'react';
import { useEditorSettingsStore } from '../../stores/editorSettingsStore';

const EDITOR_PRESETS = [
  { command: 'code', name: 'VS Code' },
  { command: 'cursor', name: 'Cursor' },
  { command: 'zed', name: 'Zed' },
  { command: 'subl', name: 'Sublime Text' },
  { command: 'atom', name: 'Atom' },
  { command: 'idea', name: 'IntelliJ IDEA' },
  { command: 'webstorm', name: 'WebStorm' },
  { command: 'vim', name: 'Vim' },
  { command: 'nvim', name: 'Neovim' },
  { command: 'emacs', name: 'Emacs' },
] as const;

export function EditorSettingsView() {
  const editorCommand = useEditorSettingsStore((s) => s.editorCommand);
  const editorName = useEditorSettingsStore((s) => s.editorName);
  const saveSettings = useEditorSettingsStore((s) => s.saveSettings);
  const loadSettings = useEditorSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const isCustom = !EDITOR_PRESETS.some((p) => p.command === editorCommand);

  const handlePresetSelect = (command: string, name: string) => {
    saveSettings({ editorCommand: command, editorName: name });
  };

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">External Editor</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Choose which editor to use when opening files from canvas views.
        </p>

        {/* Editor presets */}
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Editor</h3>
        <div className="grid grid-cols-2 gap-2 max-w-lg mb-6">
          {EDITOR_PRESETS.map((preset) => {
            const selected = editorCommand === preset.command;
            return (
              <button
                key={preset.command}
                onClick={() => handlePresetSelect(preset.command, preset.name)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer text-left ${
                  selected
                    ? 'border-ctp-accent bg-ctp-accent/10 text-ctp-text'
                    : 'border-surface-1 hover:border-surface-2 text-ctp-subtext1 hover:text-ctp-text'
                }`}
                data-testid={`editor-preset-${preset.command}`}
              >
                <span className="text-xs font-mono text-ctp-overlay1">{preset.command}</span>
                <span className="text-sm">{preset.name}</span>
              </button>
            );
          })}
        </div>

        {/* Custom command */}
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Custom Command</h3>
        <p className="text-xs text-ctp-subtext0 mb-2">
          Enter a custom shell command. The file path will be appended as an argument.
        </p>
        <div className="flex gap-2 max-w-lg">
          <input
            type="text"
            value={isCustom ? editorCommand : ''}
            placeholder={editorCommand}
            onChange={(e) => {
              const cmd = e.target.value.trim();
              if (cmd) {
                saveSettings({ editorCommand: cmd, editorName: cmd });
              }
            }}
            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-surface-1 bg-ctp-mantle text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-accent"
            data-testid="editor-custom-command"
          />
        </div>
        <p className="text-xs text-ctp-overlay0 mt-2">
          Currently using: <span className="font-mono text-ctp-text">{editorCommand}</span> ({editorName})
        </p>
      </div>
    </div>
  );
}
