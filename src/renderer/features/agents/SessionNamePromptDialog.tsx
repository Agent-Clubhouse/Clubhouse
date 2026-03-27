import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface SessionNamePromptDialogProps {
  agentId: string;
  projectPath: string;
  onDone: () => void;
}

export function SessionNamePromptDialog({ agentId, projectPath, onDone }: SessionNamePromptDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fetch the last session ID on mount
  useEffect(() => {
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agentId);
        setLastSessionId(config?.lastSessionId ?? null);
      } catch {
        // Config not available — skip
      }
    })();
  }, [projectPath, agentId]);

  // Auto-focus the input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || !lastSessionId) {
      onDone();
      return;
    }
    setSaving(true);
    try {
      await window.clubhouse.agent.updateSessionName(projectPath, agentId, lastSessionId, trimmed);
    } catch {
      // Best effort
    }
    onDone();
  }, [name, lastSessionId, projectPath, agentId, onDone]);

  const handleSkip = useCallback(() => {
    onDone();
  }, [onDone]);

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        ref={dialogRef}
        data-testid="session-name-prompt-dialog"
        className="bg-ctp-mantle border border-surface-1 rounded-xl shadow-2xl w-[400px] flex flex-col"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-1">
          <h3 className="text-sm font-semibold text-ctp-text">Name This Session</h3>
          <p className="text-xs text-ctp-subtext0 mt-1">
            Give this session a friendly name for easy identification later.
          </p>
        </div>

        {/* Input */}
        <div className="px-4 py-4">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bug fix for login flow"
            data-testid="session-name-input"
            className="w-full bg-surface-1 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
              placeholder:text-ctp-subtext0 focus:outline-none focus:border-indigo-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') handleSkip();
            }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-1">
          <button
            onClick={handleSkip}
            data-testid="session-name-skip"
            className="px-3 py-1.5 text-xs rounded-lg text-ctp-subtext0 hover:text-ctp-text
              hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            data-testid="session-name-save"
            className="px-4 py-1.5 text-xs rounded-lg bg-indigo-500 text-white hover:bg-indigo-600
              cursor-pointer transition-colors font-medium disabled:opacity-40 disabled:cursor-default"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
