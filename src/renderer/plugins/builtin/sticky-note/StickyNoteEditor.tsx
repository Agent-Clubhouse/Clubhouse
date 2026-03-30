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
  const unmountSaveRef = useRef(onUnmountSave);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    unmountSaveRef.current = onUnmountSave;
  }, [onUnmountSave]);

  useEffect(() => {
    return () => {
      unmountSaveRef.current(valueRef.current);
    };
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
