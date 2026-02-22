import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import {
  useKeyboardShortcutsStore,
  formatBinding,
  eventToBinding,
  ShortcutDefinition,
} from '../../stores/keyboardShortcutsStore';
import { pluginHotkeyRegistry, PluginShortcut } from '../../plugins/plugin-hotkeys';
import { usePluginStore } from '../../plugins/plugin-store';

function ShortcutRow({ shortcut }: { shortcut: ShortcutDefinition }) {
  const editingId = useKeyboardShortcutsStore((s) => s.editingId);
  const startEditing = useKeyboardShortcutsStore((s) => s.startEditing);
  const stopEditing = useKeyboardShortcutsStore((s) => s.stopEditing);
  const setBinding = useKeyboardShortcutsStore((s) => s.setBinding);
  const resetBinding = useKeyboardShortcutsStore((s) => s.resetBinding);

  const isEditing = editingId === shortcut.id;
  const isModified = shortcut.currentBinding !== shortcut.defaultBinding;

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
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ctp-text">{shortcut.label}</span>
      <div className="flex items-center gap-2">
        {isEditing ? (
          <span className="text-xs text-ctp-accent bg-surface-1 px-2 py-1 rounded border border-ctp-accent animate-pulse">
            Press a key combo...
          </span>
        ) : (
          <button
            onClick={() => startEditing(shortcut.id)}
            className="text-xs text-ctp-subtext1 bg-surface-0 px-2 py-1 rounded hover:bg-surface-1 cursor-pointer transition-colors"
          >
            {formatBinding(shortcut.currentBinding)}
          </button>
        )}
        {isModified && !isEditing && (
          <button
            onClick={() => resetBinding(shortcut.id)}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
            title="Reset to default"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
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
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ctp-text">{shortcut.title}</span>
      <div className="flex items-center gap-2">
        {isEditing ? (
          <span className="text-xs text-ctp-accent bg-surface-1 px-2 py-1 rounded border border-ctp-accent animate-pulse">
            Press a key combo...
          </span>
        ) : (
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs text-ctp-subtext1 bg-surface-0 px-2 py-1 rounded hover:bg-surface-1 cursor-pointer transition-colors"
          >
            {shortcut.currentBinding ? formatBinding(shortcut.currentBinding) : 'Unbound'}
          </button>
        )}
        {isModified && !isEditing && (
          <button
            onClick={() => pluginHotkeyRegistry.resetBinding(shortcut.fullCommandId)}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
            title="Reset to default"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
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
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Keyboard Shortcuts</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Customize keyboard shortcuts. Click a binding to record a new one.
        </p>

        {Object.entries(grouped).map(([category, items]) => (
          <div key={category} className="space-y-1 mb-6">
            <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">{category}</h3>
            {items.map((shortcut) => (
              <ShortcutRow key={shortcut.id} shortcut={shortcut} />
            ))}
          </div>
        ))}

        {Object.keys(pluginGrouped).length > 0 && (
          <>
            <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2 mt-8">Plugins</h3>
            {Object.entries(pluginGrouped).map(([pluginName, items]) => (
              <div key={pluginName} className="space-y-1 mb-4">
                <h4 className="text-xs text-ctp-subtext1 mb-1">{pluginName}</h4>
                {items.map((ps) => (
                  <PluginShortcutRow key={ps.fullCommandId} shortcut={ps} />
                ))}
              </div>
            ))}
          </>
        )}

        {hasAnyOverride && (
          <button
            onClick={resetAll}
            className="text-sm text-ctp-subtext0 hover:text-ctp-text cursor-pointer transition-colors"
          >
            Reset All to Defaults
          </button>
        )}
      </div>
    </div>
  );
}
