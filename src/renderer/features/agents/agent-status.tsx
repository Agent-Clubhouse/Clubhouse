import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import type { ChatSessionState } from '../../../shared/chat';
import { chatDetailedStatus, isMidTurn, type ChatStatus } from '../../../shared/chat-agent-status';

export { chatDetailedStatus, isMidTurn, type ChatStatus };

/**
 * One status vocabulary for agents (#2018): the sidebar's 8px dot and one
 * word, used by the sidebar, the pane toolbar, popouts, dashboards and the
 * avatar rings. Working, Needs you, Error, Sleeping and Done are the five
 * states; Starting covers the moment between spawn and the first event.
 */

/** What an agent's status dot shows. `idle` is an agent between turns, shown as Done. */
export type AgentDot = 'working' | 'idle' | 'needs' | 'error' | 'sleeping' | 'starting';

type DetailedLike = Pick<AgentDetailedStatus, 'state'> & Partial<Pick<AgentDetailedStatus, 'message'>>;

export function agentDot(agent: Pick<Agent, 'status'>, detailed: DetailedLike | undefined): AgentDot {
  if (agent.status === 'error' || detailed?.state === 'tool_error') return 'error';
  if (detailed?.state === 'needs_permission') return 'needs';
  if (agent.status === 'sleeping') return 'sleeping';
  if (agent.status === 'creating' || agent.status === 'spawning' || agent.status === 'waking') return 'starting';
  if (detailed?.state === 'working' || isMidTurn(detailed as AgentDetailedStatus | undefined)) return 'working';
  return 'idle';
}

/** The dot for an agent running in chat, from its session state. */
export function chatDot(state: ChatSessionState | null): AgentDot {
  switch (state) {
    case 'running': return 'working';
    case 'waiting_permission':
    case 'waiting_input': return 'needs';
    case 'error': return 'error';
    case 'sleeping': return 'sleeping';
    case 'idle': return 'idle';
    default: return 'starting';
  }
}

/** `detailed` with chat agents' status taken from their chat sessions (chatDetailedStatus). */
export function withChatStatus(
  agents: Record<string, Pick<Agent, 'id' | 'status'>>,
  detailed: Record<string, AgentDetailedStatus>,
  chat: Record<string, ChatStatus>,
): Record<string, AgentDetailedStatus> {
  let merged = detailed;
  for (const id of Object.keys(chat)) {
    const agent = agents[id];
    if (!agent) continue;
    const next = chatDetailedStatus(agent, detailed[id], chat[id]);
    if (next === detailed[id]) continue;
    if (merged === detailed) merged = { ...detailed };
    if (next) merged[id] = next;
    else delete merged[id];
  }
  return merged;
}

export const DOT_LABEL: Record<AgentDot, string> = {
  working: 'Working',
  idle: 'Done',
  needs: 'Needs you',
  error: 'Error',
  sleeping: 'Sleeping',
  starting: 'Starting',
};

export const DOT_CLASS: Record<AgentDot, string> = {
  working: 'bg-ctp-success',
  idle: 'bg-ctp-info',
  needs: 'bg-ctp-warning',
  error: 'bg-ctp-error',
  sleeping: 'border border-ctp-overlay0',
  starting: 'border border-ctp-info',
};

/** The same palette as a CSS color, for avatar rings. */
export const DOT_COLOR: Record<AgentDot, string> = {
  working: 'rgb(var(--ctp-success))',
  idle: 'rgb(var(--ctp-info))',
  needs: 'rgb(var(--ctp-warning))',
  error: 'rgb(var(--ctp-error))',
  sleeping: 'rgb(var(--ctp-overlay0))',
  starting: 'rgb(var(--ctp-info))',
};

/** The avatar ring color for an agent: the color of its status dot. */
export function statusRingColor(agent: Pick<Agent, 'status'>, detailed: DetailedLike | undefined): string {
  return DOT_COLOR[agentDot(agent, detailed)];
}

export function StatusDot({ dot, className = '' }: { dot: AgentDot; className?: string }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[dot]} ${className}`}
      role="img"
      aria-label={DOT_LABEL[dot]}
      title={DOT_LABEL[dot]}
      data-dot={dot}
    />
  );
}

/** Order for status summaries: what needs attention first. */
const SUMMARY_ORDER: AgentDot[] = ['needs', 'error', 'working', 'starting', 'idle', 'sleeping'];

/** How many agents are in each status, in summary order, skipping empty ones. */
export function statusCounts(
  agents: Pick<Agent, 'id' | 'status'>[],
  detailed: Record<string, DetailedLike | undefined>,
): { dot: AgentDot; count: number }[] {
  const counts = new Map<AgentDot, number>();
  for (const a of agents) {
    const d = agentDot(a, detailed[a.id]);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return SUMMARY_ORDER.filter((d) => counts.has(d)).map((dot) => ({ dot, count: counts.get(dot)! }));
}

/** Hook messages that only restate the status word. */
const GENERIC_MESSAGES = new Set(['Idle', 'Thinking', 'Working', 'Needs permission']);

/**
 * The status word, then what the agent is doing when that adds something
 * ("Working · Editing App.tsx"). For list rows that show status as text.
 */
export function statusText(agent: Pick<Agent, 'status'>, detailed: DetailedLike | undefined, dot = agentDot(agent, detailed)): string {
  const word = DOT_LABEL[dot];
  const msg = agent.status === 'running' ? detailed?.message : undefined;
  return msg && !GENERIC_MESSAGES.has(msg) ? `${word} · ${msg}` : word;
}

/** Text color for a status line: the states that want attention stand out. */
export const STATUS_TONE: Record<AgentDot, string> = {
  working: 'text-ctp-subtext0',
  idle: 'text-ctp-subtext0',
  needs: 'text-ctp-warning',
  error: 'text-ctp-error',
  sleeping: 'text-ctp-subtext0',
  starting: 'text-ctp-subtext0',
};
