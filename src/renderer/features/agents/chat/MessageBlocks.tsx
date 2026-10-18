import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';
import { useSafeMarkdownLinks } from '../../../utils/safe-markdown-links';
import type {
  AgentMessageItem,
  ErrorItem,
  NoticeItem,
  PlanDocumentItem,
  SessionDividerItem,
  ThoughtItem,
  TurnEndItem,
  UserMessageItem,
} from '../../../stores/chatStore';
import type { ChatCapabilities, ContentBlock } from '../../../../shared/chat';
import { attachmentName } from './attachments';
import { AlertIcon, BrainIcon, ChevronDown, ChevronRight, FileIcon, ImageIcon, PlanIcon } from './icons';
import { formatCost, formatDuration, formatTokens } from './view-model';

/** Markdown re-renders at most this often while a message streams. */
const STREAMING_RENDER_MS = 80;

export function Markdown({ text, streaming = false, className = '' }: { text: string; streaming?: boolean; className?: string }) {
  const [shown, setShown] = useState(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  latest.current = text;
  const onClick = useSafeMarkdownLinks();

  useEffect(() => {
    if (!streaming) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setShown(text);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, STREAMING_RENDER_MS);
  }, [text, streaming]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const html = useMemo(() => renderMarkdownSafe(shown), [shown]);
  return <div className={`chat-markdown ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

const SOURCE_LABELS: Partial<Record<UserMessageItem['source'], string>> = {
  mission: 'Mission',
  mcp: 'From another agent',
  shoulder_tap: 'Shoulder tap',
  group_project: 'Group project',
  annex: 'From Annex',
  system: 'Clubhouse',
};

export function UserMessage({ item }: { item: UserMessageItem }) {
  const label = SOURCE_LABELS[item.source];
  const attached = item.content
    .map((block) => ({ block, name: attachmentName(block) }))
    .filter((a): a is { block: ContentBlock; name: string } => a.name !== null);
  return (
    <div className="self-end max-w-[82%] flex flex-col items-end gap-1" data-testid="chat-user-message">
      {(label || item.delivery === 'steer') && (
        <span className="text-[11px] text-ctp-overlay0">
          {[label, item.delivery === 'steer' ? 'Steered into the running turn' : null].filter(Boolean).join(' · ')}
        </span>
      )}
      {attached.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5" data-testid="chat-user-attachments">
          {attached.map(({ block, name }, i) => (
            <span
              key={i}
              className="h-7 max-w-[220px] flex items-center gap-1.5 px-2 rounded-md bg-surface-0 text-[12px] text-ctp-subtext1"
              title={block.type === 'file' ? block.path : block.type === 'image' ? block.path ?? name : name}
            >
              {block.type === 'image' ? <ImageIcon size={13} className="text-ctp-overlay1 flex-shrink-0" /> : <FileIcon size={13} className="text-ctp-overlay1 flex-shrink-0" />}
              <span className="truncate min-w-0">{name}</span>
            </span>
          ))}
        </div>
      )}
      {item.text && (
        <div className="bg-surface-0 text-ctp-text rounded-xl rounded-br px-3 py-2 text-[13px] whitespace-pre-wrap break-words">
          {item.text}
        </div>
      )}
    </div>
  );
}

/** `preformatted`: a slash command's own laid-out output, shown as is (#2179). */
export function AgentMessage({ item, preformatted = false }: { item: AgentMessageItem; preformatted?: boolean }) {
  if (!item.text && !item.streaming) return null;
  return (
    <div className="text-[13.5px] leading-relaxed text-ctp-text" data-testid="chat-agent-message">
      {preformatted
        ? <pre className="font-mono text-[12px] leading-[1.6] text-ctp-text whitespace-pre overflow-x-auto m-0" data-testid="chat-command-output">{item.text}</pre>
        : <Markdown text={item.text} streaming={item.streaming} />}
      {item.streaming && <span className="inline-block w-1.5 h-3.5 bg-ctp-accent/70 animate-pulse align-text-bottom" aria-label="Streaming" />}
    </div>
  );
}

export function ThoughtRow({ item }: { item: ThoughtItem }) {
  const [open, setOpen] = useState(false);
  const label = item.streaming
    ? 'Thinking…'
    : item.durationMs !== undefined ? `Thought for ${formatDuration(item.durationMs)}` : 'Thought';
  return (
    <div className="flex flex-col" data-testid="chat-thought">
      <button
        type="button"
        className="flex items-center gap-2 h-6 text-[12.5px] italic text-ctp-overlay0 hover:text-ctp-subtext0 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <BrainIcon className="text-ctp-mauve" />
        <span>{label}</span>
        {item.text && (open ? <ChevronDown /> : <ChevronRight />)}
      </button>
      {open && item.text && (
        <div className="ml-[7px] pl-3 border-l border-surface-1 text-[12.5px] text-ctp-subtext0 whitespace-pre-wrap py-1">
          {item.text}
        </div>
      )}
    </div>
  );
}

export function PlanDocumentCard({ item }: { item: PlanDocumentItem }) {
  return (
    <div className="border border-surface-1 rounded-lg bg-ctp-mantle" data-testid="chat-plan-document">
      <div className="flex items-center gap-2 h-9 px-3 border-b border-surface-0 text-[12.5px]">
        <PlanIcon className="text-ctp-overlay1" />
        <span className="font-semibold text-ctp-text">Plan</span>
        <span className="text-ctp-subtext0">{item.status === 'ready' ? 'Ready for review' : 'Writing…'}</span>
      </div>
      <div className="px-4 py-3 text-[13px]">
        <Markdown text={item.markdown} streaming={item.status === 'streaming'} />
      </div>
    </div>
  );
}

export function NoticeRow({ item }: { item: NoticeItem }) {
  if (item.running) {
    // In progress (a context compaction): the tool rows' spinner, then the notice it settles into.
    return (
      <div className="flex items-center gap-2 text-[12px] text-ctp-overlay1" role="status" data-testid="chat-notice" data-code={item.code} data-running="true">
        <span className="inline-block w-2.5 h-2.5 mx-px rounded-full border-[1.5px] border-surface-1 border-t-ctp-success animate-spin" aria-hidden="true" />
        <span>{item.message}</span>
      </div>
    );
  }
  return (
    <div
      className={`flex items-center gap-2 text-[12px] ${item.level === 'warn' ? 'text-ctp-warning' : 'text-ctp-overlay1'}`}
      data-testid="chat-notice"
      data-code={item.code}
    >
      <AlertIcon size={13} />
      <span>{item.message}</span>
    </div>
  );
}

const ERROR_HINTS: Partial<Record<string, string>> = {
  auth_required: 'Sign in from the terminal view, then send your message again.',
  account_issue: 'Check your account or billing with the provider; signing in again won\'t fix this.',
  rate_limited: 'The provider rate-limited this session.',
  context_overflow: 'The conversation no longer fits in the context window.',
  max_tokens: 'The reply hit the output token limit.',
};

export function ErrorRow({ item }: { item: ErrorItem }) {
  const hint = ERROR_HINTS[item.code];
  return (
    <div className="flex items-start gap-2 text-[12.5px] text-ctp-error" role="alert" data-testid="chat-error" data-code={item.code}>
      <AlertIcon size={14} className="mt-0.5" />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="break-words">{item.message}</span>
        {(hint || item.willRetry) && (
          <span className="text-ctp-subtext0">{item.willRetry ? 'Retrying…' : hint}</span>
        )}
      </div>
    </div>
  );
}

const STOP_LABELS: Partial<Record<TurnEndItem['stopReason'], string>> = {
  cancelled: 'Stopped',
  max_tokens: 'Stopped at the output limit',
  max_turns: 'Stopped at the turn limit',
  refusal: 'The model declined to continue',
  timeout: 'Timed out',
  error: 'Turn failed',
};

export function TurnFooter({ item, turnNumber, capabilities }: { item: TurnEndItem; turnNumber: number; capabilities: ChatCapabilities | null }) {
  const usageMode = capabilities?.usage ?? 'none';
  const parts: string[] = [`Turn ${turnNumber}`];
  if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
  if (usageMode !== 'none' && usageMode !== 'context' && item.usage) {
    const { input, cachedInput, output } = item.usage;
    const tokenParts: string[] = [];
    if (input !== undefined) tokenParts.push(`${formatTokens(input)} in${cachedInput ? ` (${formatTokens(cachedInput)} cached)` : ''}`);
    if (output !== undefined) tokenParts.push(`${formatTokens(output)} out`);
    if (tokenParts.length) parts.push(tokenParts.join(' · '));
  }
  if (usageMode === 'cost' && item.costUsd !== undefined) parts.push(formatCost(item.costUsd, item.costIsEstimate));
  const stop = STOP_LABELS[item.stopReason];
  const failed = item.stopReason === 'error' || item.stopReason === 'refusal' || item.stopReason === 'timeout';
  return (
    <div
      className="flex flex-wrap gap-x-3.5 gap-y-1 items-center pt-1 border-t border-dashed border-surface-0 text-[11.5px] text-ctp-overlay0 tabular-nums"
      data-testid="chat-turn-footer"
      data-stop-reason={item.stopReason}
    >
      {stop && <span className={failed ? 'text-ctp-error' : 'text-ctp-subtext0'}>{stop}</span>}
      {parts.map((p) => <span key={p}>{p}</span>)}
    </div>
  );
}

export function SessionDivider({ item }: { item: SessionDividerItem }) {
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-ctp-overlay0 py-1" data-testid="chat-session-divider">
      <span className="flex-1 border-t border-surface-0" />
      <span>{item.resumed ? 'Session resumed' : 'New session'}</span>
      <span className="flex-1 border-t border-surface-0" />
    </div>
  );
}
