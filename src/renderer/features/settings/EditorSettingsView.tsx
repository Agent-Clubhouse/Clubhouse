import { useEffect } from 'react';
import { useEditorSettingsStore } from '../../stores/editorSettingsStore';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsInput } from './SettingsLayout';

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
    <SettingsPage title="External editor" description="The editor that opens files from canvas views.">
      <SettingsSection title="Editor">
        <SettingsBlock>
          <div className="grid grid-cols-2 gap-2">
            {EDITOR_PRESETS.map((preset) => {
              const selected = editorCommand === preset.command;
              return (
                <button
                  key={preset.command}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handlePresetSelect(preset.command, preset.name)}
                  className={`h-8 flex items-center gap-2 px-2.5 rounded-md border transition-colors cursor-pointer text-left focus-ring ${
                    selected
                      ? 'border-ctp-accent bg-surface-0 text-ctp-text'
                      : 'border-surface-1 text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
                  }`}
                  data-testid={`editor-preset-${preset.command}`}
                >
                  <span className="text-[13px]">{preset.name}</span>
                  <span className="ml-auto text-xs font-mono text-ctp-overlay1">{preset.command}</span>
                </button>
              );
            })}
          </div>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="Custom command">
        <SettingsField
          label="Command"
          help="Any shell command. Clubhouse adds the file path as the last argument."
          htmlFor="editor-custom-command"
        >
          <input
            id="editor-custom-command"
            type="text"
            value={isCustom ? editorCommand : ''}
            placeholder={editorCommand}
            onChange={(e) => {
              const cmd = e.target.value.trim();
              if (cmd) {
                saveSettings({ editorCommand: cmd, editorName: cmd });
              }
            }}
            className={`${settingsInput} w-[220px] font-mono`}
            data-testid="editor-custom-command"
          />
        </SettingsField>
        <SettingsField label="Current editor">
          <span className="text-xs text-ctp-subtext1" data-testid="editor-current">
            <span className="font-mono text-ctp-text">{editorCommand}</span> ({editorName})
          </span>
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
