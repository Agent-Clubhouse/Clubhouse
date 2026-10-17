import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ChatDriverId, UsageLimit } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { chatDot } from '../agent-status';
import { AgentPaneToolbar, type PaneUsage } from '../pane/AgentPaneToolbar';
import { formatElapsed, formatTokens } from './view-model';
import { ChatDefaultTip } from './ChatDefaultTip';

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

/** The toolbar's activity line for a chat agent: elapsed time and the running tool, or what it waits on. */
export function chatActivity(state: ChatViewState, now: number): string {
  if (state.state === 'running') {
    const parts: string[] = [];
    if (state.turnStartedAt !== null) parts.push(formatElapsed(now - state.turnStartedAt));
    for (let i = state.items.length - 1; i >= 0; i--) {
      const it = state.items[i];
      if (it.kind === 'tool_call' && (it.status === 'in_progress' || it.status === 'pending')) { parts.push(it.title); break; }
      if (it.kind === 'user_message') break;
    }
    return parts.join(' · ');
  }
  if (state.state === 'waiting_permission') return state.pendingPermissions[0]?.title ?? 'Waiting for approval';
  if (state.state === 'waiting_input') return 'Has a question';
  return '';
}

function limitLabel(l: UsageLimit): string {
  if (l.utilization !== undefined) return `${Math.round(l.utilization * 100)}%`;
  if (l.status === 'exceeded') return 'limit reached';
  if (l.status === 'warning') return 'near limit';
  return 'ok';
}

/** Session details for the orchestrator glyph's tooltip, which the old 52px header showed inline. */
export function chatDetails(agent: Agent, state: ChatViewState): string[] {
  const out: string[] = [];
  const runtime = [state.driver ? DRIVER_LABELS[state.driver] ?? state.driver : null, state.cliVersion].filter(Boolean).join(' · ');
  if (runtime) out.push(runtime);
  if (agent.branch) out.push(`Branch ${agent.branch}`);
  return out;
}

function limitHot(l: UsageLimit): boolean {
  return l.status === 'exceeded' || (l.utilization !== undefined && l.utilization >= 0.9);
}

/** The toolbar's context meter: context fill and plan limits with their reset times, red when one runs out. */
export function chatUsage(state: ChatViewState): PaneUsage | null {
  const caps = state.capabilities;
  const ctx = caps && caps.usage !== 'none' ? state.usage.context : null;
  const limits = caps?.limits ? state.usage.limits : [];
  const pct = ctx && ctx.size > 0 ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;
  if (pct === null && limits.length === 0) return null;
  const lines: string[] = [];
  if (pct !== null && ctx) lines.push(`Context ${pct}%: ${formatTokens(ctx.used)} of ${formatTokens(ctx.size)} tokens`);
  for (const l of limits) {
    const reset = l.resetsAt ? `, resets ${new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    lines.push(`${l.window} limit: ${limitLabel(l)}${reset}`);
  }
  return { contextPct: pct, hot: (pct !== null && pct >= 90) || limits.some(limitHot), lines };
}

export { RuntimeSwitch, type RuntimeView } from '../pane/AgentPaneToolbar';

interface ChatHeaderProps {
  agent: Agent;
  state: ChatViewState;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
  /** Toggle for the Changes panel; omitted hides the button. */
  onToggleChanges?: () => void;
  changesOpen?: boolean;
  /** Toggle for the agent map, with its subagent count; omitted hides the button. */
  onToggleAgentMap?: () => void;
  agentMapOpen?: boolean;
  subagentCount?: number;
  /** DOM ids tying the toggle to the panel it controls. */
  agentMapPanelId?: string;
  agentMapToggleId?: string;
  /** Offer the agent's ⋯ menu (main pane only). */
  showMenu?: boolean;
  /** Name the agent in the bar (the classic shell's main pane has no breadcrumb). */
  showName?: boolean;
}

/** The chat runtime's pane toolbar: AgentPaneToolbar fed from the chat session. */
export function ChatHeader({ agent, state, onSwitchToTerminal, switching, onToggleChanges, changesOpen, onToggleAgentMap, agentMapOpen, subagentCount, agentMapPanelId, agentMapToggleId, showMenu, showName }: ChatHeaderProps) {
  const now = useNow(state.state === 'running' && state.turnStartedAt !== null);
  return (
    <AgentPaneToolbar
      agent={agent}
      orchestrator={state.provider}
      dot={chatDot(state.state)}
      activity={chatActivity(state, now)}
      model={state.model ?? agent.model}
      details={chatDetails(agent, state)}
      usage={chatUsage(state)}
      changes={onToggleChanges ? { open: !!changesOpen, onToggle: onToggleChanges } : undefined}
      agentMap={onToggleAgentMap && agentMapPanelId && agentMapToggleId
        ? { open: !!agentMapOpen, onToggle: onToggleAgentMap, count: subagentCount ?? 0, panelId: agentMapPanelId, toggleId: agentMapToggleId }
        : undefined}
      runtime={onSwitchToTerminal
        ? { value: 'chat', onChange: onSwitchToTerminal, disabled: switching, tip: <ChatDefaultTip agent={agent} /> }
        : undefined}
      showMenu={showMenu}
      showName={showName}
    />
  );
}
