import React from 'react';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';
import type { NoteColor } from './StickyNoteCanvasWidget';

// Full class names spelled out so Tailwind includes them in the build.
const COLOR_DOT_CLASSES: Record<NoteColor, string> = {
  yellow: 'bg-ctp-yellow/60 border-ctp-yellow',
  blue:   'bg-ctp-blue/60 border-ctp-blue',
  green:  'bg-ctp-green/60 border-ctp-green',
  pink:   'bg-ctp-pink/60 border-ctp-pink',
};

interface StickyNoteViewerProps {
  content: string;
  color: NoteColor;
  noteColors: NoteColor[];
  onEdit: () => void;
  onColorChange: (color: NoteColor) => void;
}

export function StickyNoteViewer({ content, color, noteColors, onEdit, onColorChange }: StickyNoteViewerProps) {
  const html = renderMarkdownSafe(content);

  return (
    <div className="flex flex-col h-full" data-testid="sticky-note-viewer">
      <div className="flex items-center justify-end gap-1.5 px-2 py-1 border-b border-ctp-surface1 shrink-0">
        {noteColors.map((c) => (
          <button
            key={c}
            title={c}
            className={`w-4 h-4 rounded-full border ${COLOR_DOT_CLASSES[c]} ${
              c === color ? 'ring-1 ring-ctp-text ring-offset-1 ring-offset-transparent' : ''
            }`}
            onClick={() => onColorChange(c)}
            data-testid={`sticky-note-color-${c}`}
          />
        ))}
      </div>
      <div
        className="flex-1 overflow-auto p-3 text-xs text-ctp-text sticky-note-prose cursor-text"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onEdit}
        data-testid="sticky-note-content"
      />
    </div>
  );
}
