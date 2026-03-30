import React, { useState, useEffect, useRef } from 'react';

interface StickyNoteEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** Called on unmount with the current draft — prevents data loss if the widget is closed mid-edit. */
  onUnmountSave: (content: string) => void;
}

export function StickyNoteEditor({ content, onSave, onUnmountSave }: StickyNoteEditorProps) {
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
      <textarea
        className="flex-1 resize-none bg-transparent text-ctp-text text-xs p-2 outline-none font-mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSave(value)}
        autoFocus
        placeholder="Write markdown here…"
        data-testid="sticky-note-textarea"
      />
    </div>
  );
}
