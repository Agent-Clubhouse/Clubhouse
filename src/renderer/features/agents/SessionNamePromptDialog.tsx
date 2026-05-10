import { useState, useRef, useEffect, useCallback } from 'react';
import { Modal } from '../../components/Modal';

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

  return (
    <Modal open={true} onClose={handleSkip} title="Name This Session" width="w-[400px]">
      <div data-testid="session-name-prompt-dialog">
      <p className="text-xs text-ctp-subtext0 mb-3">
        Give this session a friendly name for easy identification later.
      </p>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Bug fix for login flow"
        data-testid="session-name-input"
        className="w-full bg-surface-1 border border-surface-2 rounded-lg px-3 py-2 text-sm text-ctp-text
          placeholder:text-ctp-subtext0 focus-ring mb-4"
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
        }}
      />
      <div className="flex items-center justify-end gap-2">
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
          className="px-4 py-1.5 text-xs rounded-lg bg-ctp-accent text-white hover:bg-ctp-accent/80
            cursor-pointer transition-colors font-medium disabled:opacity-40 disabled:cursor-default"
        >
          Save
        </button>
      </div>
      </div>
    </Modal>
  );
}
