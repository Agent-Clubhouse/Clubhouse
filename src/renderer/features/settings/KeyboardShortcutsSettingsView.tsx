import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import {
  useKeyboardShortcutsStore,
  formatBinding,
  eventToBinding,
  ShortcutDefinition,
} from '../../stores/keyboardShortcutsStore';
import { pluginHotkeyRegistry, PluginShortcut } from '../../plugins/plugin-hotkeys';
import { usePluginStore } from '../../plugins/plugin-store';
import { useClipboardSettingsStore } from '../../stores/clipboardSettingsStore';
import { Toggle } from '../../components/Toggle';
import { SettingsPage, SettingsSection, SettingsField, settingsButton } from './SettingsLayout';

const ROW = 'flex items-center gap-3 min-h-[30px] py-1 border-t border-surface-0';
const KBD = 'inline-flex items-center px-1.5 h-5 rounded border border-surface-1 text-xs font-mono text-ctp-subtext1';
const KBD_BUTTON = `${KBD} cursor-pointer hover:bg-surface-0 hover:text-ctp-text transition-colors focus-ring`;
const RECORDING = 'inline-flex items-center px-1.5 h-5 rounded border border-ctp-accent text-xs text-ctp-accent animate-pulse';

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

const RESET_BUTTON = 'w-5 h-5 inline-flex items-center justify-center rounded text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 cursor-pointer focus-ring';

function ShortcutRow({ shortcut }: { shortcut: ShortcutDefinition }) {
  const editingId = useKeyboardShortcutsStore((s) => s.editingId);
  const startEditing = useKeyboardShortcutsStore((s) => s.startEditing);
  const stopEditing = useKeyboardShortcutsStore((s) => s.stopEditing);
  const setBinding = useKeyboardShortcutsStore((s) => s.setBinding);
  const resetBinding = useKeyboardShortcutsStore((s) => s.resetBinding);

  const conflictLabel = useKeyboardShortcutsStore((s) => (shortcut.conflictWith ? s.shortcuts[shortcut.conflictWith]?.label : undefined));

  const isEditing = editingId === shortcut.id;
  // An action left unbound by a conflict is not "modified"; there is nothing of its own to reset.
  const isModified = !shortcut.conflictWith && shortcut.currentBinding !== shortcut.defaultBinding;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        stopEditing();
        return;
      }
      const binding = eventToBinding(e);
      if (binding) {
        setBinding(shortcut.id, binding);
      }
    },
    [shortcut.id, setBinding, stopEditing],
  );

  useEffect(() => {
    if (!isEditing) return;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isEditing, handleKeyDown]);

  return (
    <div className={ROW} data-testid={`shortcut-row-${shortcut.id}`}>
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-[13px] text-ctp-text">{shortcut.label}</span>
        {shortcut.conflictWith && (
          <span className="text-xs text-ctp-warning">
            Unbound because {formatBinding(shortcut.defaultBinding)} is set for {conflictLabel ?? shortcut.conflictWith}
          </span>
        )}
      </span>
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {isModified && !isEditing && (
          <button
            type="button"
            onClick={() => resetBinding(shortcut.id)}
            className={RESET_BUTTON}
            title="Reset to default"
            aria-label="Reset to default"
          >
            <ResetIcon />
          </button>
        )}
        {isEditing ? (
          <span className={RECORDING}>Press a key combo…</span>
        ) : (
          <button type="button" onClick={() => startEditing(shortcut.id)} className={KBD_BUTTON}>
            {shortcut.currentBinding ? formatBinding(shortcut.currentBinding) : 'Unbound'}
          </button>
        )}
      </div>
    </div>
  );
}

function PluginShortcutRow({ shortcut }: { shortcut: PluginShortcut }) {
  const [isEditing, setIsEditing] = useState(false);
  const isModified = shortcut.currentBinding !== shortcut.defaultBinding;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setIsEditing(false);
        return;
      }
      const binding = eventToBinding(e);
      if (binding) {
        pluginHotkeyRegistry.setBinding(shortcut.fullCommandId, binding);
        setIsEditing(false);
      }
    },
    [shortcut.fullCommandId],
  );

  useEffect(() => {
    if (!isEditing) return;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isEditing, handleKeyDown]);

  return (
    <div className={ROW}>
      <span className="flex-1 min-w-0 text-[13px] text-ctp-text">{shortcut.title}</span>
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {isModified && !isEditing && (
          <button
            type="button"
            onClick={() => pluginHotkeyRegistry.resetBinding(shortcut.fullCommandId)}
            className={RESET_BUTTON}
            title="Reset to default"
            aria-label="Reset to default"
          >
            <ResetIcon />
          </button>
        )}
        {isEditing ? (
          <span className={RECORDING}>Press a key combo…</span>
        ) : (
          <button type="button" onClick={() => setIsEditing(true)} className={KBD_BUTTON}>
            {shortcut.currentBinding ? formatBinding(shortcut.currentBinding) : 'Unbound'}
          </button>
        )}
      </div>
    </div>
  );
}

function usePluginShortcuts(): PluginShortcut[] {
  return useSyncExternalStore(
    (cb) => pluginHotkeyRegistry.onChange(cb).dispose,
    () => pluginHotkeyRegistry.getAll(),
  );
}

export function KeyboardShortcutsSettingsView() {
  const shortcuts = useKeyboardShortcutsStore((s) => s.shortcuts);
  const resetAll = useKeyboardShortcutsStore((s) => s.resetAll);
  const pluginShortcuts = usePluginShortcuts();
  const pluginsMap = usePluginStore((s) => s.plugins);
  const clipboardCompat = useClipboardSettingsStore((s) => s.clipboardCompat);
  const loadClipboard = useClipboardSettingsStore((s) => s.loadSettings);
  const saveClipboard = useClipboardSettingsStore((s) => s.saveSettings);

  useEffect(() => { loadClipboard(); }, [loadClipboard]);

  // Group system shortcuts by category
  const grouped: Record<string, ShortcutDefinition[]> = {};
  for (const shortcut of Object.values(shortcuts)) {
    if (!grouped[shortcut.category]) grouped[shortcut.category] = [];
    grouped[shortcut.category].push(shortcut);
  }

  // Group plugin shortcuts by plugin name
  const pluginGrouped: Record<string, PluginShortcut[]> = {};
  for (const ps of pluginShortcuts) {
    const pluginName = pluginsMap[ps.pluginId]?.manifest.name ?? ps.pluginId;
    if (!pluginGrouped[pluginName]) pluginGrouped[pluginName] = [];
    pluginGrouped[pluginName].push(ps);
  }

  const hasAnyOverride = Object.values(shortcuts).some(
    (s) => s.currentBinding !== s.defaultBinding,
  );

  return (
    <SettingsPage
      title="Keyboard shortcuts"
      description="Click a binding to record a new one."
      actions={hasAnyOverride ? (
        <button type="button" onClick={resetAll} className={settingsButton.ghost}>
          Reset all to defaults
        </button>
      ) : undefined}
    >
      <SettingsSection title="Compatibility">
        <SettingsField
          label="Clipboard compatibility"
          help="Use explicit clipboard handling for terminal paste. Turn this on if paste does not work on your platform."
        >
          <Toggle ariaLabel="Clipboard compatibility" checked={clipboardCompat} onChange={(v) => saveClipboard(v)} />
        </SettingsField>
      </SettingsSection>

      {Object.entries(grouped).map(([category, items]) => (
        <SettingsSection key={category} title={category}>
          {items.map((shortcut) => (
            <ShortcutRow key={shortcut.id} shortcut={shortcut} />
          ))}
        </SettingsSection>
      ))}

      {Object.keys(pluginGrouped).length > 0 && (
        <SettingsSection title="Plugins">
          {Object.entries(pluginGrouped).map(([pluginName, items]) => (
            <div key={pluginName}>
              <div className="text-xs text-ctp-overlay1 pt-2.5 pb-1 border-t border-surface-0">{pluginName}</div>
              {items.map((ps) => (
                <PluginShortcutRow key={ps.fullCommandId} shortcut={ps} />
              ))}
            </div>
          ))}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
