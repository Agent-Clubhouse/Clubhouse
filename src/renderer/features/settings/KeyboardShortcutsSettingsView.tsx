import { useEffect, useCallback } from 'react';
import {
  useKeyboardShortcutsStore,
  formatBinding,
  eventToBinding,
  ShortcutDefinition,
} from '../../stores/keyboardShortcutsStore';

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

export function KeyboardShortcutsSettingsView() {
  const shortcuts = useKeyboardShortcutsStore((s) => s.shortcuts);
  const resetAll = useKeyboardShortcutsStore((s) => s.resetAll);

  // Group shortcuts by category
  const grouped: Record<string, ShortcutDefinition[]> = {};
  for (const shortcut of Object.values(shortcuts)) {
    if (!grouped[shortcut.category]) grouped[shortcut.category] = [];
    grouped[shortcut.category].push(shortcut);
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
