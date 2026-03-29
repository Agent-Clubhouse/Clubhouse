import { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import type { AssistantMode, AssistantStatus } from './assistant-agent';

interface OrchestratorInfo {
  id: string;
  displayName: string;
  shortName?: string;
}

interface Props {
  onReset: () => void;
  mode: AssistantMode;
  onModeChange: (mode: AssistantMode) => void;
  orchestrator: string | null;
  onOrchestratorChange: (id: string | null) => void;
  status: AssistantStatus;
}

const MODE_LABELS: Record<AssistantMode, { label: string; title: string }> = {
  interactive: { label: 'Terminal', title: 'Terminal — full interactive PTY, same as durable agents' },
  headless: { label: 'Chat', title: 'Chat — multi-turn conversation, most reliable' },
  structured: { label: 'Structured', title: 'Structured — experimental, typed events' },
};

const STATUS_LABELS: Record<AssistantStatus, string> = {
  idle: 'Ready to help',
  starting: 'Starting up\u2026',
  active: 'Listening',
  responding: 'Thinking\u2026',
  error: 'Something went wrong',
};

export function AssistantHeader({ onReset, mode, onModeChange, orchestrator, onOrchestratorChange, status }: Props) {
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const [orchestrators, setOrchestrators] = useState<OrchestratorInfo[]>([]);

  useEffect(() => {
    window.clubhouse.agent.getOrchestrators?.()
      .then((list: OrchestratorInfo[]) => setOrchestrators(list || []))
      .catch(() => {});
  }, []);

  const statusColor = status === 'error' ? 'text-red-400' :
    status === 'responding' ? 'text-ctp-accent' :
    'text-ctp-subtext0';

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0 bg-ctp-mantle flex-shrink-0" data-testid="assistant-header">
      {/* Left: mascot icon + title + status */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-8 h-8 rounded-full bg-ctp-accent/10 flex items-center justify-center flex-shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-accent">
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <circle cx="12" cy="5" r="2" />
            <line x1="12" y1="7" x2="12" y2="11" />
            <line x1="8" y1="16" x2="8" y2="16.01" />
            <line x1="16" y1="16" x2="16" y2="16.01" />
          </svg>
        </div>
        <div className="min-w-0">
          <span className="text-sm font-semibold text-ctp-text block leading-tight">Assistant</span>
          <span className={`text-xs ${statusColor} block leading-tight`} data-testid="assistant-status">
            {status === 'responding' && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-accent animate-pulse mr-1 align-middle" />
            )}
            {STATUS_LABELS[status]}
          </span>
        </div>
      </div>

      {/* Right: controls */}
      <div className="flex items-center gap-1.5">
        {/* Orchestrator selector */}
        {orchestrators.length > 0 && (
          <select
            value={orchestrator || ''}
            onChange={(e) => onOrchestratorChange(e.target.value || null)}
            className="bg-ctp-base border border-surface-0 rounded px-1.5 py-0.5 text-[10px] text-ctp-subtext0 outline-none cursor-pointer"
            title="Orchestrator"
            data-testid="orchestrator-select"
          >
            <option value="">Default</option>
            {orchestrators.map((o) => (
              <option key={o.id} value={o.id}>{o.shortName || o.displayName}</option>
            ))}
          </select>
        )}

        {/* Mode toggle */}
        <div className="flex items-center bg-ctp-base rounded-lg border border-surface-0 overflow-hidden" data-testid="mode-toggle">
          {(Object.keys(MODE_LABELS) as AssistantMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`px-2 py-1 text-[10px] font-medium transition-colors cursor-pointer ${
                mode === m
                  ? 'bg-ctp-accent text-white shadow-sm'
                  : 'text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0'
              }`}
              title={MODE_LABELS[m].title}
              data-testid={`mode-${m}`}
            >
              {MODE_LABELS[m].label}
            </button>
          ))}
        </div>

        {/* Reset */}
        <button
          onClick={onReset}
          className="p-1 text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 rounded transition-colors cursor-pointer"
          title="New conversation"
          data-testid="assistant-reset-button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>

        {/* Help docs */}
        <button
          onClick={() => setExplorerTab('help')}
          className="p-1 text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 rounded transition-colors cursor-pointer"
          title="Help docs"
          data-testid="classic-help-button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
      </div>
    </div>
  );
}
