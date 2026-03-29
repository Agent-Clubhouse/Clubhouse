import React, { useState, useEffect, useRef } from 'react';

interface StickyNoteEditorProps {
  content: string;
  onSave: (content: string) => void;
  onCancel: () => void;
  /** Called on unmount with the current draft — prevents data loss if the widget is closed mid-edit. */
  onUnmountSave: (content: string) => void;
}

export function StickyNoteEditor({ content, onSave, onCancel, onUnmountSave }: StickyNoteEditorProps) {
  const [value, setValue] = useState(content);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      onUnmountSave(valueRef.current);
    };
  // onUnmountSave identity is stable per widget instance; deps intentionally omitted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full" data-testid="sticky-note-editor">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-ctp-surface1 shrink-0">
        <button
          className="text-xs px-2 py-0.5 bg-ctp-blue text-ctp-base rounded hover:bg-ctp-blue/80"
          onClick={() => onSave(value)}
          data-testid="sticky-note-save"
        >
          Save
        </button>
        <button
          className="text-xs px-2 py-0.5 bg-ctp-surface1 text-ctp-text rounded hover:bg-ctp-surface2"
          onClick={onCancel}
          data-testid="sticky-note-cancel"
        >
          Cancel
        </button>
      </div>
      <textarea
        className="flex-1 resize-none bg-transparent text-ctp-text text-xs p-2 outline-none font-mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        placeholder="Write markdown here…"
        data-testid="sticky-note-textarea"
      />
    </div>
  );
}
