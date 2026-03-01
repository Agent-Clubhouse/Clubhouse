import { useState, useEffect, useCallback, useRef } from 'react';

interface SessionEntry {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
  friendlyName?: string;
}

interface SessionPickerDialogProps {
  agentId: string;
  projectPath: string;
  orchestrator?: string;
  onResume: (sessionId: string) => void;
  onClose: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export function SessionPickerDialog({ agentId, projectPath, orchestrator, onResume, onClose }: SessionPickerDialogProps) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [manualId, setManualId] = useState('');
  const [showManual, setShowManual] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.clubhouse.agent.listSessions(projectPath, agentId, orchestrator);
      setSessions(result);
    } catch {
      setSessions([]);
    }
    setLoading(false);
  }, [projectPath, agentId, orchestrator]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Close on Escape or outside click
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
    }
  }, [editingId]);

  const handleRename = useCallback(async (sessionId: string) => {
    const name = editValue.trim() || null;
    await window.clubhouse.agent.updateSessionName(projectPath, agentId, sessionId, name);
    setEditingId(null);
    setEditValue('');
    loadSessions();
  }, [editValue, projectPath, agentId, loadSessions]);

  const startEditing = useCallback((session: SessionEntry) => {
    setEditingId(session.sessionId);
    setEditValue(session.friendlyName || '');
  }, []);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        ref={dialogRef}
        data-testid="session-picker-dialog"
        className="bg-ctp-mantle border border-surface-1 rounded-xl shadow-2xl w-[480px] max-h-[500px] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-1">
          <h3 className="text-sm font-semibold text-ctp-text">Resume Session</h3>
          <button
            onClick={onClose}
            className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center py-8 text-ctp-subtext0 text-sm">
              Loading sessions...
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-ctp-subtext0 text-sm gap-2">
              <p>No sessions found</p>
              <button
                onClick={() => setShowManual(true)}
                className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
              >
                Enter a session ID manually
              </button>
            </div>
          )}

          {!loading && sessions.map((session, idx) => (
            <div
              key={session.sessionId}
              data-testid={`session-entry-${idx}`}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-1 group transition-colors"
            >
              {/* Session info */}
              <div className="flex-1 min-w-0">
                {editingId === session.sessionId ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); handleRename(session.sessionId); }}
                    className="flex items-center gap-2"
                  >
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="Enter a name..."
                      className="flex-1 bg-surface-1 border border-surface-2 rounded px-2 py-1 text-xs text-ctp-text focus:outline-none focus:border-indigo-500"
                      onBlur={() => handleRename(session.sessionId)}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setEditingId(null); } }}
                    />
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ctp-text truncate">
                        {session.friendlyName || `Session ${session.sessionId.slice(0, 8)}`}
                      </span>
                      {idx === 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 shrink-0">
                          latest
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ctp-subtext0 mt-0.5">
                      {formatRelativeTime(session.lastActiveAt)}
                      <span className="mx-1 opacity-50">·</span>
                      <span className="font-mono opacity-60">{session.sessionId.slice(0, 12)}...</span>
                    </div>
                  </>
                )}
              </div>

              {/* Actions */}
              {editingId !== session.sessionId && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={() => startEditing(session)}
                    title="Rename"
                    className="p-1 rounded text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-2 cursor-pointer transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onResume(session.sessionId)}
                    data-testid={`resume-session-${idx}`}
                    className="px-2.5 py-1 text-xs rounded bg-indigo-500 text-white hover:bg-indigo-600 cursor-pointer transition-colors font-medium"
                  >
                    Resume
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer with manual entry */}
        <div className="border-t border-surface-1 px-4 py-3">
          {showManual || sessions.length > 0 ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="Or enter a session ID..."
                className="flex-1 bg-surface-1 border border-surface-2 rounded px-2.5 py-1.5 text-xs text-ctp-text placeholder:text-ctp-subtext0 focus:outline-none focus:border-indigo-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && manualId.trim()) {
                    onResume(manualId.trim());
                  }
                }}
              />
              <button
                onClick={() => manualId.trim() && onResume(manualId.trim())}
                disabled={!manualId.trim()}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-text hover:bg-surface-2 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default"
              >
                Resume
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
