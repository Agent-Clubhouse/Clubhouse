import React, { useState, useEffect } from 'react';
import type { CanvasWidgetComponentProps, ThemeInfo } from '../../../../shared/plugin-types';
import { StickyNoteEditor } from './StickyNoteEditor';
import { StickyNoteViewer } from './StickyNoteViewer';

export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink';

export const NOTE_COLORS: NoteColor[] = ['yellow', 'blue', 'green', 'pink'];

// Full class names spelled out so Tailwind includes them in the build.
export const TINTS: Record<NoteColor, Record<'dark' | 'light', string>> = {
  yellow: {
    dark:  'bg-ctp-warning/10 border-ctp-warning/30',
    light: 'bg-ctp-warning/15 border-ctp-warning/40',
  },
  blue: {
    dark:  'bg-ctp-accent/10 border-ctp-accent/30',
    light: 'bg-ctp-accent/15 border-ctp-accent/40',
  },
  green: {
    dark:  'bg-ctp-success/10 border-ctp-success/30',
    light: 'bg-ctp-success/15 border-ctp-success/40',
  },
  pink: {
    dark:  'bg-ctp-error/10 border-ctp-error/30',
    light: 'bg-ctp-error/15 border-ctp-error/40',
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

  // Called when the textarea blurs — saves content and returns to preview mode.
  const handleBlurSave = (newContent: string) => {
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
          onSave={handleBlurSave}
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
