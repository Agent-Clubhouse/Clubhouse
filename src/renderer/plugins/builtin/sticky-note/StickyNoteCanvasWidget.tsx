import React, { useState, useEffect } from 'react';
import type { CanvasWidgetComponentProps, ThemeInfo } from '../../../../shared/plugin-types';
import { StickyNoteEditor } from './StickyNoteEditor';
import { StickyNoteViewer } from './StickyNoteViewer';

export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink';

export const NOTE_COLORS: NoteColor[] = ['yellow', 'blue', 'green', 'pink'];

// Full class names spelled out so Tailwind includes them in the build.
export const TINTS: Record<NoteColor, Record<'dark' | 'light', string>> = {
  yellow: {
    dark:  'bg-ctp-yellow/10 border-ctp-yellow/30',
    light: 'bg-ctp-yellow/15 border-ctp-yellow/40',
  },
  blue: {
    dark:  'bg-ctp-blue/10 border-ctp-blue/30',
    light: 'bg-ctp-blue/15 border-ctp-blue/40',
  },
  green: {
    dark:  'bg-ctp-green/10 border-ctp-green/30',
    light: 'bg-ctp-green/15 border-ctp-green/40',
  },
  pink: {
    dark:  'bg-ctp-pink/10 border-ctp-pink/30',
    light: 'bg-ctp-pink/15 border-ctp-pink/40',
  },
};

export function StickyNoteCanvasWidget({ api, metadata, onUpdateMetadata }: CanvasWidgetComponentProps) {
  const content = (metadata.content as string) ?? '';
  const color = (metadata.color as NoteColor) ?? 'yellow';
  const [editing, setEditing] = useState(false);
  const [theme, setTheme] = useState<ThemeInfo>(() => api.theme.getCurrent());

  useEffect(() => {
    const sub = api.theme.onDidChange((t) => setTheme(t));
    return () => sub.dispose();
  }, [api]);

  const tint = (TINTS[color] ?? TINTS.yellow)[theme.type];

  const handleSave = (newContent: string) => {
    onUpdateMetadata({ content: newContent });
    setEditing(false);
  };

  const handleColorChange = (newColor: NoteColor) => {
    onUpdateMetadata({ color: newColor });
  };

  return (
    <div className={`flex flex-col h-full border ${tint}`} data-testid="sticky-note-widget">
      {editing ? (
        <StickyNoteEditor
          content={content}
          onSave={handleSave}
          onCancel={() => setEditing(false)}
          onUnmountSave={(val) => onUpdateMetadata({ content: val })}
        />
      ) : (
        <StickyNoteViewer
          content={content}
          color={color}
          noteColors={NOTE_COLORS}
          onEdit={() => setEditing(true)}
          onColorChange={handleColorChange}
        />
      )}
    </div>
  );
}
