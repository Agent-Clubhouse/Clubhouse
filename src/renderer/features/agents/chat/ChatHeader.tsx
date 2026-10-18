import { useEffect, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ChatDriverId, UsageLimit } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { chatDot } from '../agent-status';
import { AgentPaneToolbar, type PaneUsage, type ReviewView } from '../pane/AgentPaneToolbar';
import { formatElapsed, formatTokens } from './view-model';
import { ChatDefaultTip } from './ChatDefaultTip';

export const DRIVER_LABELS: Record<ChatDriverId, string> = {
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
    if (state.compactionItemId !== null) return [...parts, 'Compacting context'].join(' · ');
    for (let i = state.items.length - 1; i >= 0; i--) {
      const it = state.items[i];
      if (it.kind === 'tool_call' && (it.status === 'in_progress' || it.status === 'pending')) { parts.push(it.title); break; }
      if (it.kind === 'user_message') break;
    }
    return parts.join(' · ');
  }
  if (state.state === 'waiting_permission') return state.pendingPermissions[0]?.title ?? 'Waiting for approval';
  if (state.state === 'waiting_input') return 'Has a question';
  // Claude can compact an idle session on its own.
  if (state.compactionItemId !== null) return 'Compacting context';
  return '';
}

const LIMIT_NAMES: Record<string, { name: string; short: string }> = {
  '5h': { name: 'Session (5-hour)', short: '5h' },
  week: { name: 'Weekly', short: 'wk' },
  week_opus: { name: 'Weekly Opus', short: 'wk Opus' },
  week_sonnet: { name: 'Weekly Sonnet', short: 'wk Sonnet' },
  week_oauth_apps: { name: 'Weekly apps', short: 'wk apps' },
  week_overage_included: { name: 'Weekly with extra usage', short: 'wk+' },
  overage: { name: 'Extra usage', short: 'extra' },
};

/** A plan window's name for people: "Session (5-hour)", "Weekly", "Weekly Fable". */
export function limitName(window: string): string {
  if (window.startsWith('week:')) return `Weekly ${window.slice(5)}`;
  return LIMIT_NAMES[window]?.name ?? window;
}

function limitShort(window: string): string {
  if (window.startsWith('week:')) return `wk ${window.slice(5)}`;
  return LIMIT_NAMES[window]?.short ?? window;
}

export function limitLabel(l: UsageLimit): string {
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

/** A limit the user has run out of. */
function limitReached(l: UsageLimit): boolean {
  return l.status === 'exceeded' || (l.utilization !== undefined && l.utilization >= 1);
}

/** A limit at warning or above: the provider says so, or it's 80% used. */
function limitWarning(l: UsageLimit): boolean {
  return limitReached(l) || l.status === 'warning' || (l.utilization !== undefined && l.utilization >= 0.8);
}

const pctOf = (l: UsageLimit) => (l.utilization !== undefined ? Math.round(l.utilization * 100) : null);

/** The limit that matters most: reached first, then warning, then the most used. */
function worstLimit(limits: UsageLimit[]): UsageLimit | undefined {
  const rank = (l: UsageLimit) => (limitReached(l) ? 2 : limitWarning(l) ? 1 : 0);
  return [...limits].sort((a, b) => rank(b) - rank(a) || (b.utilization ?? -1) - (a.utilization ?? -1))[0];
}

/**
 * The toolbar's meter. The ring shows context fill; a plan limit takes over
 * when one is at warning or above (amber, red once reached), or when there is
 * no context to show. The tooltip lists context and every limit with its reset.
 */
export function chatUsage(state: ChatViewState): PaneUsage | null {
  const caps = state.capabilities;
  const ctx = caps && caps.usage !== 'none' ? state.usage.context : null;
  const limits = caps?.limits ? state.usage.limits : [];
  const ctxPct = ctx && ctx.size > 0 ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;
  if (ctxPct === null && limits.length === 0) return null;
  const lines: string[] = [];
  if (ctxPct !== null && ctx) lines.push(`Context ${ctxPct}%: ${formatTokens(ctx.used)} of ${formatTokens(ctx.size)} ${ctx.window === 'input' ? 'input ' : ''}tokens`);
  for (const l of limits) {
    const reset = l.resetsAt ? `, resets ${new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    lines.push(`${limitName(l.window)} limit: ${limitLabel(l)}${reset}`);
  }
  const worst = worstLimit(limits);
  // Context keeps the ring while there is one; a limit takes over only once
  // it's reached (or when there's no context). A warning tints the tone.
  const limitShown = worst && (limitReached(worst) || ctxPct === null) ? worst : undefined;
  const ctxHot = ctxPct !== null && ctxPct >= 90;
  const tone = ctxHot || (worst && limitReached(worst)) ? 'hot' : worst && limitWarning(worst) ? 'warn' : 'normal';
  if (limitShown) {
    const pct = pctOf(limitShown);
    const amount = pct !== null ? `${pct}%` : limitLabel(limitShown);
    // A limit known only as "ok" has nothing to draw.
    const quiet = pct === null && !limitWarning(limitShown);
    return {
      // A limit known only by status ("near limit") fills from context, if any.
      fillPct: pct ?? ctxPct,
      text: quiet ? null : `${amount} ${limitShort(limitShown.window)}`,
      label: `${limitName(limitShown.window)} limit ${amount}`,
      tone,
      lines,
    };
  }
  return { fillPct: ctxPct, text: ctxPct !== null ? `${ctxPct}%` : null, label: `Context ${ctxPct}%`, tone, lines };
}

export { RuntimeSwitch, type RuntimeView } from '../pane/AgentPaneToolbar';

interface ChatHeaderProps {
  agent: Agent;
  state: ChatViewState;
  onSwitchToTerminal?: () => void;
  switching?: boolean;
  /** The Agent details toggle (#2032), in the toolbar's slot for it. */
  detailsToggle?: ReactNode;
  /** The Changes review segment (#2032). */
  review?: ReviewView;
  /** Offer the agent's ⋯ menu (main pane only). */
  showMenu?: boolean;
  /** Name the agent in the bar (the classic shell's main pane has no breadcrumb). */
  showName?: boolean;
}

/** The chat runtime's pane toolbar: AgentPaneToolbar fed from the chat session. */
export function ChatHeader({ agent, state, onSwitchToTerminal, switching, detailsToggle, review, showMenu, showName }: ChatHeaderProps) {
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
      runtime={onSwitchToTerminal
        ? { value: 'chat', onChange: onSwitchToTerminal, disabled: switching, tip: <ChatDefaultTip agent={agent} /> }
        : { value: 'chat' }}
      review={review}
      detailsToggle={detailsToggle}
      showMenu={showMenu}
      showName={showName}
    />
  );
}
