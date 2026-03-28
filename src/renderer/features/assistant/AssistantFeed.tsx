import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { AssistantMessage } from './AssistantMessage';
import { AssistantActionCard } from './AssistantActionCard';
import type { FeedItem, ActionGroup } from './types';
import type { AssistantStatus } from './assistant-agent';

const SUGGESTED_PROMPTS = [
  { label: 'Set up a project', prompt: 'Help me set up a new project in Clubhouse' },
  { label: 'Configure agents', prompt: 'Help me configure agents for my project' },
  { label: 'Build a canvas', prompt: 'Create a multi-agent canvas for debugging' },
  { label: 'Learn the basics', prompt: 'What is Clubhouse and what can it do?' },
  { label: 'Write agent instructions', prompt: 'Help me write agent instructions' },
  { label: 'What orchestrators are available?', prompt: 'What orchestrators are available?' },
];

interface Props {
  items: FeedItem[];
  status: AssistantStatus;
  onSendPrompt: (prompt: string) => void;
  onApproveAction?: (actionId: string) => void;
  onSkipAction?: (actionId: string) => void;
}

/** Group consecutive actions sharing the same groupId. */
export function buildGroups(items: FeedItem[]): Array<FeedItem | { type: 'grouped'; group: ActionGroup; actions: FeedItem[] }> {
  const result: Array<FeedItem | { type: 'grouped'; group: ActionGroup; actions: FeedItem[] }> = [];
  let currentGroup: { groupId: string; actions: FeedItem[] } | null = null;

  for (const item of items) {
    const groupId = item.type === 'action' && item.action?.groupId;

    if (groupId && currentGroup?.groupId === groupId) {
      currentGroup.actions.push(item);
    } else {
      // Flush previous group
      if (currentGroup && currentGroup.actions.length > 1) {
        const actions = currentGroup.actions;
        const statuses = actions.map(a => a.action!.status);
        const groupStatus: ActionGroup['status'] =
          statuses.every(s => s === 'completed') ? 'completed' :
          statuses.some(s => s === 'error') ? 'error' :
          statuses.some(s => s === 'running') ? 'running' :
          statuses.some(s => s === 'completed') ? 'partial' :
          'pending_approval';
        result.push({
          type: 'grouped',
          group: {
            id: currentGroup.groupId,
            label: inferGroupLabel(actions),
            actionIds: actions.map(a => a.action!.id),
            status: groupStatus,
          },
          actions,
        });
      } else if (currentGroup) {
        result.push(...currentGroup.actions);
      }

      if (groupId) {
        currentGroup = { groupId, actions: [item] };
      } else {
        currentGroup = null;
        result.push(item);
      }
    }
  }

  // Flush trailing group
  if (currentGroup && currentGroup.actions.length > 1) {
    const actions = currentGroup.actions;
    const statuses = actions.map(a => a.action!.status);
    const groupStatus: ActionGroup['status'] =
      statuses.every(s => s === 'completed') ? 'completed' :
      statuses.some(s => s === 'error') ? 'error' :
      statuses.some(s => s === 'running') ? 'running' :
      statuses.some(s => s === 'completed') ? 'partial' :
      'pending_approval';
    result.push({
      type: 'grouped',
      group: {
        id: currentGroup.groupId,
        label: inferGroupLabel(actions),
        actionIds: actions.map(a => a.action!.id),
        status: groupStatus,
      },
      actions,
    });
  } else if (currentGroup) {
    result.push(...currentGroup.actions);
  }

  return result;
}

/** Infer a human-readable group label from the actions in the group. */
export function inferGroupLabel(actions: FeedItem[]): string {
  const tools = actions.map(a => a.action!.toolName);
  if (tools.includes('create_canvas')) {
    const cardCount = tools.filter(t => t === 'add_card').length;
    const wireCount = tools.filter(t => t === 'add_wire').length;
    const details: string[] = [];
    if (cardCount) details.push(`${cardCount} card${cardCount > 1 ? 's' : ''}`);
    if (wireCount) details.push(`${wireCount} wire${wireCount > 1 ? 's' : ''}`);
    return details.length ? `Creating canvas with ${details.join(', ')}` : 'Creating canvas';
  }
  if (tools.includes('create_project')) {
    return `Setting up project (${actions.length} steps)`;
  }
  return `${actions.length} related actions`;
}

/**
 * Scrollable message feed with auto-scroll behavior.
 * Shows welcome state with suggestion chips when empty.
 * Centered content with max-width for readability.
 */
export function AssistantFeed({ items, status, onSendPrompt, onApproveAction, onSkipAction }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 60;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll to bottom when new items arrive (if user hasn't scrolled up)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isNearBottomRef.current) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  // Must call useMemo before any early return to maintain hook ordering
  const grouped = useMemo(() => buildGroups(items), [items]);

  if (items.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4" data-testid="assistant-feed-empty">
        <div className="max-w-md text-center">
          {/* Mascot placeholder */}
          <div className="flex justify-center mb-5">
            <div className="w-20 h-20 rounded-full bg-ctp-accent/10 flex items-center justify-center">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ctp-accent"
              >
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" />
                <line x1="12" y1="7" x2="12" y2="11" />
                <line x1="8" y1="16" x2="8" y2="16.01" />
                <line x1="16" y1="16" x2="16" y2="16.01" />
              </svg>
            </div>
          </div>
          <p className="text-base text-ctp-text mb-1 font-semibold">
            Hi! I&apos;m the Clubhouse Assistant.
          </p>
          <p className="text-sm text-ctp-subtext0 mb-6 leading-relaxed">
            I can set up projects, configure agents, build canvases,
            write agent instructions, and more.
          </p>
          <div className="flex flex-wrap gap-2 justify-center" data-testid="suggested-prompts">
            {SUGGESTED_PROMPTS.map(({ label, prompt }) => (
              <button
                key={label}
                onClick={() => onSendPrompt(prompt)}
                className="px-3 py-2 text-xs rounded-lg border border-surface-0 text-ctp-subtext0 hover:text-ctp-text hover:border-ctp-accent/40 hover:bg-ctp-accent/5 transition-colors cursor-pointer"
                data-testid="suggested-prompt"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
      data-testid="assistant-feed"
    >
      <div className="max-w-[600px] mx-auto space-y-3">
        {grouped.map((entry) => {
          if ('group' in entry && entry.type === 'grouped') {
            return (
              <ActionGroupCard
                key={entry.group.id}
                group={entry.group}
                actions={entry.actions}
                onApprove={onApproveAction}
                onSkip={onSkipAction}
              />
            );
          }
          const item = entry as FeedItem;
          if (item.type === 'message' && item.message) {
            return <AssistantMessage key={item.message.id} message={item.message} />;
          }
          if (item.type === 'action' && item.action) {
            return (
              <AssistantActionCard
                key={item.action.id}
                action={item.action}
                onApprove={onApproveAction}
                onSkip={onSkipAction}
              />
            );
          }
          return null;
        })}
        {/* Loading indicator when assistant is thinking */}
        {status === 'responding' && (
          <div className="flex justify-start" data-testid="assistant-typing">
            <div className="px-3 py-2 rounded-lg bg-ctp-mantle">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Action Group Card ────────────────────────────────────────────────────────

interface ActionGroupCardProps {
  group: ActionGroup;
  actions: FeedItem[];
  onApprove?: (actionId: string) => void;
  onSkip?: (actionId: string) => void;
}

function ActionGroupCard({ group, actions, onApprove, onSkip }: ActionGroupCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor =
    group.status === 'completed' ? 'text-green-400' :
    group.status === 'error' ? 'text-red-400' :
    group.status === 'running' ? 'text-ctp-accent' :
    'text-ctp-subtext0';

  const completedCount = actions.filter(a => a.action?.status === 'completed').length;

  return (
    <div
      className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle"
      data-testid="action-group"
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <span className={`text-xs font-medium ${statusColor}`}>
          {group.status === 'running' ? '...' : group.status === 'completed' ? '\u2713' : group.status === 'error' ? '\u2717' : '\u25CB'}
        </span>
        <span className="text-xs font-medium text-ctp-text">{group.label}</span>
        <span className="ml-auto text-[10px] text-ctp-subtext0 tabular-nums">
          {completedCount}/{actions.length}
        </span>
        <svg
          className={`w-3 h-3 text-ctp-subtext0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-surface-0 space-y-1 p-2">
          {actions.map(item => item.action && (
            <AssistantActionCard
              key={item.action.id}
              action={item.action}
              onApprove={onApprove}
              onSkip={onSkip}
            />
          ))}
        </div>
      )}
    </div>
  );
}
