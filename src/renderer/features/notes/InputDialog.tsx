import { useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  placeholder: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InputDialog({ title, placeholder, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleSubmit = () => {
    if (value.trim()) onConfirm(value.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[380px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-3">{title}</h2>
        <input
          ref={inputRef}
          className="w-full text-sm bg-ctp-surface0 text-ctp-text rounded-lg px-3 py-2 outline-none border border-ctp-surface2 focus:border-ctp-lavender mb-4"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
              hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="px-4 py-1.5 text-xs rounded bg-ctp-lavender/80 text-ctp-base
              hover:bg-ctp-lavender cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
