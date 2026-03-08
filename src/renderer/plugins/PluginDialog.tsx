import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ── Types ──────────────────────────────────────────────────────────────

interface InputDialogProps {
  prompt: string;
  defaultValue: string;
  onResolve: (value: string | null) => void;
}

interface ConfirmDialogProps {
  message: string;
  onResolve: (confirmed: boolean) => void;
}

// ── InputDialog ────────────────────────────────────────────────────────

function InputDialog({ prompt, defaultValue, onResolve }: InputDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolved = useRef(false);

  const resolve = useCallback((result: string | null) => {
    if (resolved.current) return;
    resolved.current = true;
    onResolve(result);
  }, [onResolve]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => resolve(null)}
      data-testid="plugin-dialog-overlay"
    >
      <div
        className="bg-ctp-mantle border border-ctp-surface1 rounded-xl shadow-2xl w-[400px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="plugin-dialog"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-ctp-surface0">
          <h3 className="text-sm font-semibold text-ctp-text">{prompt}</h3>
        </div>

        {/* Input */}
        <div className="px-4 py-4">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="plugin-dialog-input"
            className="w-full bg-ctp-base border border-ctp-surface1 rounded-lg px-3 py-2 text-sm text-ctp-text
              placeholder:text-ctp-subtext0 focus:outline-none focus:border-ctp-accent"
            onKeyDown={(e) => {
              if (e.key === 'Enter') resolve(value);
              if (e.key === 'Escape') resolve(null);
            }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-ctp-surface0">
          <button
            onClick={() => resolve(null)}
            data-testid="plugin-dialog-cancel"
            className="px-3 py-1.5 text-xs rounded-lg text-ctp-subtext0 hover:text-ctp-text
              hover:bg-ctp-surface0 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => resolve(value)}
            data-testid="plugin-dialog-ok"
            className="px-4 py-1.5 text-xs rounded-lg bg-ctp-accent text-ctp-base hover:opacity-90
              cursor-pointer transition-colors font-medium"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ConfirmDialog ──────────────────────────────────────────────────────

function ConfirmDialog({ message, onResolve }: ConfirmDialogProps) {
  const resolved = useRef(false);

  const resolve = useCallback((result: boolean) => {
    if (resolved.current) return;
    resolved.current = true;
    onResolve(result);
  }, [onResolve]);

  // Keyboard support
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') resolve(true);
      if (e.key === 'Escape') resolve(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [resolve]);

  // Auto-detect destructive actions
  const isDestructive = /\bdelete\b/i.test(message);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => resolve(false)}
      data-testid="plugin-dialog-overlay"
    >
      <div
        className="bg-ctp-mantle border border-ctp-surface1 rounded-xl shadow-2xl w-[400px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="plugin-dialog"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-ctp-surface0">
          <h3 className="text-sm font-semibold text-ctp-text">Confirm</h3>
        </div>

        {/* Message */}
        <div className="px-4 py-4">
          <p className="text-sm text-ctp-subtext1" data-testid="plugin-dialog-message">{message}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-ctp-surface0">
          <button
            onClick={() => resolve(false)}
            data-testid="plugin-dialog-cancel"
            className="px-3 py-1.5 text-xs rounded-lg text-ctp-subtext0 hover:text-ctp-text
              hover:bg-ctp-surface0 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => resolve(true)}
            data-testid="plugin-dialog-confirm"
            className={`px-4 py-1.5 text-xs rounded-lg cursor-pointer transition-colors font-medium ${
              isDestructive
                ? 'bg-ctp-red text-ctp-base hover:opacity-90'
                : 'bg-ctp-accent text-ctp-base hover:opacity-90'
            }`}
          >
            {isDestructive ? 'Delete' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers to mount dialogs ───────────────────────────────────────────

export function showInputDialog(prompt: string, defaultValue = ''): { promise: Promise<string | null>; cleanup: () => void } {
  const container = document.createElement('div');
  container.setAttribute('data-plugin-dialog', 'input');
  document.body.appendChild(container);
  const root = createRoot(container);

  let resolvePromise: (value: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    resolvePromise = resolve;
  });

  const cleanup = () => {
    root.unmount();
    container.remove();
  };

  const handleResolve = (value: string | null) => {
    cleanup();
    resolvePromise(value);
  };

  root.render(
    <InputDialog prompt={prompt} defaultValue={defaultValue} onResolve={handleResolve} />
  );

  return { promise, cleanup: () => handleResolve(null) };
}

export function showConfirmDialog(message: string): { promise: Promise<boolean>; cleanup: () => void } {
  const container = document.createElement('div');
  container.setAttribute('data-plugin-dialog', 'confirm');
  document.body.appendChild(container);
  const root = createRoot(container);

  let resolvePromise: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });

  const cleanup = () => {
    root.unmount();
    container.remove();
  };

  const handleResolve = (value: boolean) => {
    cleanup();
    resolvePromise(value);
  };

  root.render(
    <ConfirmDialog message={message} onResolve={handleResolve} />
  );

  return { promise, cleanup: () => handleResolve(false) };
}
