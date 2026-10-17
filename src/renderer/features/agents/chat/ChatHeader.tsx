import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ChatDriverId, UsageLimit } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { AgentAvatar } from '../AgentAvatar';
import { formatElapsed, formatTokens } from './view-model';

const DRIVER_LABELS: Record<ChatDriverId, string> = {
  claude_agent_sdk: 'Agent SDK',
  claude_stream_json: 'stream-json',
  codex_app_server: 'app-server',
  copilot_acp: 'ACP',
  copilot_sdk: 'Copilot SDK',
  acp: 'ACP',
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function StatePill({ state }: { state: ChatViewState }) {
  const running = state.state === 'running';
  const now = useNow(running && state.turnStartedAt !== null);
  const s = state.state;
  let dot = 'bg-ctp-accent';
  let text = 'Idle';
  let tone = 'text-ctp-overlay1';
  if (s === 'running') {
    dot = 'bg-ctp-success';
    tone = 'text-ctp-success';
    text = state.turnStartedAt !== null ? `Working · ${formatElapsed(now - state.turnStartedAt)}` : 'Working';
  } else if (s === 'waiting_permission' || s === 'waiting_input') {
    dot = 'bg-ctp-warning';
    tone = 'text-ctp-warning';
    text = 'Waiting for you';
  } else if (s === 'starting' || s === null) {
    dot = 'bg-surface-2';
    text = 'Starting';
  } else if (s === 'sleeping') {
    dot = 'border border-ctp-overlay0 bg-transparent';
    text = 'Sleeping';
  } else if (s === 'error') {
    dot = 'bg-ctp-error';
    tone = 'text-ctp-error';
    text = 'Error';
  }
  return (
    <span className={`flex items-center gap-1.5 text-[11.5px] ${tone}`} data-testid="chat-state">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {text}
    </span>
  );
}

function limitLabel(l: UsageLimit): string {
  if (l.utilization !== undefined) return `${Math.round(l.utilization * 100)}%`;
  if (l.status === 'exceeded') return 'limit reached';
  if (l.status === 'warning') return 'near limit';
  return 'ok';
}

function LimitMeter({ limit }: { limit: UsageLimit }) {
  const pct = limit.utilization !== undefined ? Math.min(100, Math.round(limit.utilization * 100)) : null;
  const hot = limit.status === 'exceeded' || (pct !== null && pct >= 90);
  const reset = limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-ctp-subtext0 tabular-nums" title={`${limit.window} limit: ${limitLabel(limit)}${reset}`} data-testid="chat-limit">
      {pct !== null && (
        <span className="relative w-9 h-[5px] rounded-full bg-surface-0 overflow-hidden">
          <span className={`absolute inset-y-0 left-0 rounded-full ${hot ? 'bg-ctp-error' : 'bg-ctp-accent'}`} style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="font-medium text-ctp-overlay1">{limit.window}</span>
      <span className={hot ? 'text-ctp-error' : ''}>{limitLabel(limit)}</span>
    </span>
  );
}

function ContextRing({ used, size }: { used: number; size: number }) {
  const pct = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0;
  const r = 12;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative w-[30px] h-[30px] grid place-items-center" title={`Context: ${formatTokens(used)} of ${formatTokens(size)} tokens`} data-testid="chat-context">
      <svg width="30" height="30" viewBox="0 0 30 30" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="15" cy="15" r={r} fill="none" strokeWidth="3" className="stroke-surface-0" />
        <circle cx="15" cy="15" r={r} fill="none" strokeWidth="3" strokeDasharray={`${(pct / 100) * c} ${c}`} className={pct >= 90 ? 'stroke-ctp-error' : 'stroke-ctp-info'} />
      </svg>
      <span className="text-[11px] text-ctp-subtext0 tabular-nums">{pct}%</span>
    </span>
  );
}

export type RuntimeView = 'chat' | 'terminal';

export function RuntimeSwitch({ value, onChange, disabled }: { value: RuntimeView; onChange: (v: RuntimeView) => void; disabled?: boolean }) {
  return (
    <span className="inline-flex bg-surface-0 rounded-md p-0.5 text-[11.5px]" role="radiogroup" aria-label="Chat or terminal" data-testid="runtime-switch">
      {(['chat', 'terminal'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => { if (v !== value) onChange(v); }}
          className={`px-2.5 py-0.5 rounded ${value === v ? 'bg-ctp-base text-ctp-text' : 'text-ctp-overlay1 hover:text-ctp-subtext1'} disabled:opacity-50`}
        >
          {v === 'chat' ? 'Chat' : 'Terminal'}
        </button>
      ))}
    </span>
  );
}

interface ChatHeaderProps {
  agent: Agent;
  state: ChatViewState;
  providerName: string;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
}

export function ChatHeader({ agent, state, providerName, onSwitchToTerminal, switching }: ChatHeaderProps) {
  const caps = state.capabilities;
  const limits = caps?.limits ? state.usage.limits : [];
  const context = caps && caps.usage !== 'none' ? state.usage.context : null;
  return (
    <div className="h-[52px] flex-shrink-0 flex items-center gap-2.5 px-4 border-b border-surface-0" data-testid="chat-header">
      <AgentAvatar agent={agent} size="xs" />
      <div className="flex flex-col gap-px min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-[13.5px] text-ctp-text truncate">{agent.name}</span>
          <StatePill state={state} />
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-ctp-overlay1 min-w-0 whitespace-nowrap">
          <span>{providerName}</span>
          {state.driver && <><span className="text-surface-2">·</span><span className="font-mono">{DRIVER_LABELS[state.driver] ?? state.driver}</span></>}
          {state.cliVersion && <><span className="text-surface-2">·</span><span className="font-mono">{state.cliVersion}</span></>}
          {agent.branch && <><span className="text-surface-2">·</span><span className="font-mono truncate">{agent.branch}</span></>}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        {limits.map((l) => <LimitMeter key={l.window} limit={l} />)}
        {context && context.size > 0 && <ContextRing used={context.used} size={context.size} />}
        {onSwitchToTerminal && <RuntimeSwitch value="chat" onChange={onSwitchToTerminal} disabled={switching} />}
      </div>
    </div>
  );
}
