/** Test helper: the KeyboardEvent init for a physical chord like "Meta+Alt+Shift+ArrowLeft". */
export function chordEventInit(chord: string): KeyboardEventInit {
  const parts = chord.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const letter = /^[A-Z]$/.test(key);
  return {
    key: letter ? (mods.has('Shift') ? key : key.toLowerCase()) : key,
    code: letter ? `Key${key}` : undefined,
    metaKey: mods.has('Meta'),
    ctrlKey: mods.has('Ctrl'),
    altKey: mods.has('Alt'),
    shiftKey: mods.has('Shift'),
    bubbles: true,
    cancelable: true,
  };
}
