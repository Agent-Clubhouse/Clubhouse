import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ChatMcpServer, ToolCallContent, ToolKind } from '../../../../shared/chat';
import type { ToolCallItem } from '../../../stores/chatStore';
import type { SubagentBlock } from './view-model';
import {
  argSummary,
  commandOf,
  diffContent,
  diffLines,
  diffStats,
  exploreLabel,
  formatDuration,
  formatTokens,
  mcpTool,
  terminalContent,
  toolArgs,
  toolErrorText,
  toolOpenByDefault,
  toolResultText,
  toolTarget,
  type DiffLine,
} from './view-model';
import { AgentsIcon, BrainIcon, ChevronDown, ChevronRight, EditIcon, FileIcon, GlobeIcon, SearchIcon, TerminalIcon, ToolIcon } from './icons';
import { AgentMessage, ThoughtRow } from './MessageBlocks';

const KIND_ICONS: Record<ToolKind, (p: { className?: string }) => ReactNode> = {
  read: FileIcon,
  edit: EditIcon,
  delete: EditIcon,
  move: FileIcon,
  search: SearchIcon,
  execute: TerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: ToolIcon,
  other: ToolIcon,
};

const KIND_VERBS: Record<ToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Think',
  fetch: 'Fetch',
  switch_mode: 'Mode',
  other: 'Tool',
};

function Spin() {
  return <span className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-surface-1 border-t-ctp-success animate-spin" aria-label="Running" />;
}

interface TranscriptExpansionStore {
  get: (key: string) => boolean | undefined;
  set: (key: string, open: boolean) => void;
  subscribe: (key: string, listener: () => void) => () => void;
}

export function createTranscriptExpansionStore(): TranscriptExpansionStore {
  const values = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => values.get(key),
    set: (key, open) => {
      if (values.get(key) === open) return;
      values.set(key, open);
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe: (key, listener) => {
      const keyListeners = listeners.get(key) ?? new Set();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },
  };
}

const TranscriptExpansionContext = createContext<TranscriptExpansionStore | null>(null);

export function TranscriptExpansionProvider({ store, children }: { store: TranscriptExpansionStore; children: ReactNode }) {
  return <TranscriptExpansionContext.Provider value={store}>{children}</TranscriptExpansionContext.Provider>;
}

function useOpenState(defaultOpen: boolean, expansionKey?: string): [boolean, () => void] {
  const store = useContext(TranscriptExpansionContext);
  const subscribe = useCallback((listener: () => void) => (
    store && expansionKey ? store.subscribe(expansionKey, listener) : () => undefined
  ), [store, expansionKey]);
  const getSnapshot = useCallback(() => (
    store && expansionKey ? store.get(expansionKey) : undefined
  ), [store, expansionKey]);
  const storedOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [localOpen, setLocalOpen] = useState<boolean | undefined>(undefined);
  const open = storedOpen ?? localOpen ?? defaultOpen;
  const toggle = useCallback(() => {
    if (store && expansionKey) store.set(expansionKey, !open);
    else setLocalOpen(!open);
  }, [store, expansionKey, open]);
  return [open, toggle];
}

function StatusMeta({ tool }: { tool: ToolCallItem }) {
  if (tool.status === 'pending') return <span className="text-ctp-warning">waiting for approval</span>;
  if (tool.status === 'in_progress') return <><Spin /> running</>;
  if (tool.status === 'failed') return <span className="text-ctp-error">failed</span>;
  if (tool.status === 'cancelled') return <span>cancelled</span>;
  return tool.durationMs !== undefined ? <span>{formatDuration(tool.durationMs)}</span> : null;
}

export function ToolRow({ tool }: { tool: ToolCallItem }) {
  const Ico = KIND_ICONS[tool.toolKind] ?? ToolIcon;
  const target = toolTarget(tool);
  const pending = tool.status === 'pending';
  const error = toolErrorText(tool);
  return (
    <div className="flex flex-col" data-testid="chat-tool-row" data-status={tool.status}>
      <div className={`flex items-center gap-2 min-w-0 text-[12.5px] text-ctp-overlay1 ${pending ? 'h-[30px] px-2 rounded-md bg-surface-0/60' : 'h-6'}`}>
        <Ico className="text-ctp-overlay1" />
        <span className="font-medium text-ctp-subtext1 flex-shrink-0">{KIND_VERBS[tool.toolKind]}</span>
        <span className="font-mono text-[11.5px] text-ctp-subtext0 truncate min-w-0" title={target}>{target}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap"><StatusMeta tool={tool} /></span>
      </div>
      {error && <div className="ml-6 text-[12px] text-ctp-error break-words">{error}</div>}
    </div>
  );
}

export function ExploreGroup({ tools, expansionKey }: { tools: ToolCallItem[]; expansionKey?: string }) {
  const [open, toggle] = useOpenState(false, expansionKey);
  const running = tools.some((t) => t.status === 'in_progress');
  return (
    <div className="flex flex-col" data-testid="chat-explore-group">
      <button
        type="button"
        className="flex items-center gap-2 h-6 text-[12.5px] text-left text-ctp-overlay1 hover:text-ctp-subtext0"
        onClick={toggle}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="text-ctp-overlay0" /> : <ChevronRight className="text-ctp-overlay0" />}
        <span className="font-medium text-ctp-subtext1">{exploreLabel(tools, running)}</span>
        {running && <Spin />}
      </button>
      {open && (
        <div className="ml-[7px] pl-3 border-l border-surface-1 flex flex-col">
          {tools.map((t) => <ToolRow key={t.id} tool={t} />)}
        </div>
      )}
    </div>
  );
}

/** Open state for a tool card: follows the status until the user toggles it (see toolOpenByDefault). */
function useToolOpen(status: ToolCallItem['status'] | undefined, expansionKey?: string): [boolean, () => void] {
  return useOpenState(status !== undefined && toolOpenByDefault(status), expansionKey);
}

const CARD_HEADER = 'flex items-center gap-2 h-[34px] px-3 text-[12.5px] text-ctp-overlay1 min-w-0';

/**
 * A card header that toggles the body when `onToggle` is given, and is static
 * otherwise. `indent` keeps a static row aligned with its collapsible neighbours.
 */
function CardHeader({ open, onToggle, label, indent, children }: { open: boolean; onToggle?: () => void; label: string; indent?: boolean; children: ReactNode }) {
  const border = open ? 'border-b border-surface-0' : '';
  if (!onToggle) return <div className={`${CARD_HEADER} ${border}`}>{indent && <span className="w-3.5 flex-shrink-0" aria-hidden="true" />}{children}</div>;
  return (
    <button type="button" className={`${CARD_HEADER} ${border} w-full text-left hover:text-ctp-subtext0`} onClick={onToggle} aria-expanded={open} aria-label={label}>
      {open ? <ChevronDown className="text-ctp-overlay0 flex-shrink-0" /> : <ChevronRight className="text-ctp-overlay0 flex-shrink-0" />}
      {children}
    </button>
  );
}

function DiffBody({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="font-mono text-[11.5px] leading-[1.65] py-1 overflow-x-auto">
      {lines.map((l, i) => (
        l.type === 'hunk'
          ? <div key={i} className="px-3 text-ctp-overlay0">{l.text}</div>
          : (
            <div
              key={i}
              className={`flex gap-2 px-3 whitespace-pre ${l.type === 'add' ? 'bg-ctp-success/10 text-ctp-success' : l.type === 'del' ? 'bg-ctp-error/10 text-ctp-error' : 'text-ctp-subtext0'}`}
              data-diff={l.type}
            >
              <span className="w-7 text-right text-surface-2 flex-shrink-0 select-none">{l.type === 'del' ? l.oldNo : l.newNo}</span>
              <span className="w-2.5 flex-shrink-0 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              <span>{l.text}</span>
            </div>
          )
      ))}
    </div>
  );
}

/** Lines shown before "Show all" on a long diff. */
const DIFF_PREVIEW_LINES = 40;

/**
 * A file edit. In the transcript it collapses to its header (pass `open` and
 * `onToggle`); elsewhere (Changes, review, run insets) it is always open.
 */
export function DiffCard({ diff, line, status, open = true, onToggle }: {
  diff: Extract<ToolCallContent, { type: 'diff' }>;
  line?: number;
  status?: ToolCallItem['status'];
  open?: boolean;
  onToggle?: () => void;
}) {
  const lines = useMemo(() => diffLines(diff, line), [diff, line]);
  const { added, removed } = useMemo(() => diffStats(lines), [lines]);
  const [expanded, setExpanded] = useState(false);
  const created = diff.oldText === undefined && !diff.unifiedDiff;
  const deleted = diff.newText === undefined && !diff.unifiedDiff && diff.oldText !== undefined;
  const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="chat-diff-card" data-open={open}>
      <CardHeader open={open} onToggle={onToggle} label={`${open ? 'Collapse' : 'Expand'} edit of ${diff.path}`}>
        <EditIcon />
        {(created || deleted) && <span className="text-ctp-subtext0">{created ? 'Created' : 'Deleted'}</span>}
        <span className="font-mono text-[11.5px] text-ctp-text truncate min-w-0" title={diff.path}>{diff.path}</span>
        <span className="font-mono text-[11.5px] text-ctp-success">+{added}</span>
        <span className="font-mono text-[11.5px] text-ctp-error">−{removed}</span>
        {status === 'pending' && <span className="ml-auto text-[11.5px] text-ctp-warning">waiting for approval</span>}
        {status === 'failed' && <span className="ml-auto text-[11.5px] text-ctp-error">failed</span>}
      </CardHeader>
      {open && <DiffBody lines={shown} />}
      {open && lines.length > DIFF_PREVIEW_LINES && (
        <button type="button" className="w-full text-[11.5px] text-ctp-overlay1 hover:text-ctp-text py-1 border-t border-surface-0" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** A diff card in the transcript: collapsed to its header until opened. */
function TranscriptDiffCard({ diff, line, status, expansionKey }: { diff: Extract<ToolCallContent, { type: 'diff' }>; line?: number; status: ToolCallItem['status']; expansionKey?: string }) {
  const [open, toggle] = useToolOpen(status, expansionKey);
  return <DiffCard diff={diff} line={line} status={status} open={open} onToggle={toggle} />;
}

/** Output lines kept visible; older lines scroll inside the card. */
const OUTPUT_MAX_HEIGHT = 'max-h-56';

export function CommandCard({ tool, expansionKey }: { tool: ToolCallItem; expansionKey?: string }) {
  // Output arrives in many appended chunks; join them only when they change.
  const term = useMemo(() => terminalContent(tool), [tool]);
  const command = useMemo(() => commandOf(tool), [tool]);
  const [open, toggle] = useToolOpen(tool.status, expansionKey);
  const running = tool.status === 'in_progress';
  const exit = term?.exitCode;
  const error = toolErrorText(tool, term?.output);
  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="chat-command-card" data-status={tool.status} data-open={open}>
      <CardHeader open={open} onToggle={toggle} label={`${open ? 'Collapse' : 'Expand'} command ${command}`}>
        <TerminalIcon />
        <span className="font-mono text-[11.5px] text-ctp-text truncate min-w-0" title={command}>$ {command}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap">
          {running ? <><Spin /> running</>
            : tool.status === 'pending' ? <span className="text-ctp-warning">waiting for approval</span>
              : exit !== undefined ? <><span className={exit === 0 ? 'text-ctp-success font-mono' : 'text-ctp-error font-mono'}>exit {exit}</span>{tool.durationMs !== undefined && <span>· {formatDuration(tool.durationMs)}</span>}</>
                : <StatusMeta tool={tool} />}
        </span>
      </CardHeader>
      {open && term && term.output && (
        <pre className={`font-mono text-[11.5px] leading-[1.65] text-ctp-subtext0 px-3 py-2 bg-ctp-crust whitespace-pre-wrap break-words overflow-y-auto ${OUTPUT_MAX_HEIGHT} m-0`}>
          {term.output.replace(/\n$/, '')}
        </pre>
      )}
      {open && error && <div className="px-3 py-1.5 text-[12px] text-ctp-error border-t border-surface-0" data-testid="chat-tool-error">{error}</div>}
    </div>
  );
}

/**
 * Any other tool call, MCP included: one row with the tool and a short summary;
 * open it for the arguments and what came back.
 */
export function ToolCard({ tool, mcpServers, expansionKey }: { tool: ToolCallItem; mcpServers?: ChatMcpServer[] | null; expansionKey?: string }) {
  const mcp = useMemo(() => mcpTool(tool, mcpServers), [tool, mcpServers]);
  const args = useMemo(() => toolArgs(tool), [tool]);
  const result = useMemo(() => toolResultText(tool), [tool]);
  const error = toolErrorText(tool, result);
  const [open, toggle] = useToolOpen(tool.status, expansionKey);
  const Ico = KIND_ICONS[tool.toolKind] ?? ToolIcon;
  const label = mcp ? `${mcp.server} · ${mcp.tool}` : KIND_VERBS[tool.toolKind];
  const summary = mcp ? argSummary(tool) : toolTarget(tool);
  // Built-in tools show their input only when it isn't already the summary (e.g. a path).
  const showArgs = args !== null && (mcp !== null || tool.toolKind === 'other');
  const expandable = showArgs || result !== '' || !!error;
  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="chat-tool-card" data-status={tool.status} data-open={expandable && open} data-mcp={mcp ? 'true' : undefined}>
      <CardHeader open={expandable && open} onToggle={expandable ? toggle : undefined} indent label={`${open ? 'Collapse' : 'Expand'} ${label}`}>
        <Ico className="text-ctp-overlay1 flex-shrink-0" />
        <span className="font-medium text-ctp-subtext1 flex-shrink-0 max-w-[50%] truncate" title={label}>{label}</span>
        {summary && <span className="font-mono text-[11.5px] text-ctp-subtext0 truncate min-w-0" title={summary}>{summary}</span>}
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap"><StatusMeta tool={tool} /></span>
      </CardHeader>
      {expandable && open && (
        <div className="flex flex-col">
          {showArgs && (
            <pre className={`font-mono text-[11.5px] leading-[1.65] text-ctp-subtext0 px-3 py-2 whitespace-pre-wrap break-words overflow-y-auto ${OUTPUT_MAX_HEIGHT} m-0`} data-testid="chat-tool-args">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          {result && (
            <pre className={`font-mono text-[11.5px] leading-[1.65] text-ctp-subtext0 px-3 py-2 bg-ctp-crust whitespace-pre-wrap break-words overflow-y-auto ${OUTPUT_MAX_HEIGHT} m-0 ${showArgs ? 'border-t border-surface-0' : ''}`} data-testid="chat-tool-result">
              {result.replace(/\n$/, '')}
            </pre>
          )}
          {error && <div className={`px-3 py-1.5 text-[12px] text-ctp-error ${showArgs || result ? 'border-t border-surface-0' : ''}`} data-testid="chat-tool-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * One tool call in the transcript: a diff card per file edit, a command card for
 * commands, a tool card otherwise. All start collapsed to one row (toolOpenByDefault).
 */
export function ToolCallView({ tool, mcpServers, expansionKey }: { tool: ToolCallItem; mcpServers?: ChatMcpServer[] | null; expansionKey?: string }) {
  const diffs = diffContent(tool);
  if (diffs.length > 0) {
    const error = toolErrorText(tool);
    return (
      <>
        {diffs.map((d, i) => <TranscriptDiffCard key={`${d.path}:${i}`} diff={d} line={tool.locations?.[0]?.line} status={tool.status} expansionKey={expansionKey && `${expansionKey}:diff:${i}`} />)}
        {error && <div className="text-[12px] text-ctp-error">{error}</div>}
      </>
    );
  }
  if (tool.toolKind === 'execute' || tool.content.some((c) => c.type === 'terminal')) return <CommandCard tool={tool} expansionKey={expansionKey} />;
  return <ToolCard tool={tool} mcpServers={mcpServers} expansionKey={expansionKey} />;
}

const SUB_STATUS: Record<SubagentBlock['info']['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function SubagentCard({ block, onOpenInMap, expansionKey }: { block: SubagentBlock; onOpenInMap?: (subagentId: string) => void; expansionKey?: string }) {
  const [open, toggle] = useOpenState(false, expansionKey);
  const { info, tool, children } = block;
  const toolCount = info.toolCount ?? children.filter((c) => c.kind === 'tool_call').length;
  const summary = [...children].reverse().find((c) => c.kind === 'agent_message');
  const meta: string[] = [];
  if (toolCount) meta.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  if (tool?.durationMs !== undefined) meta.push(formatDuration(tool.durationMs));
  const tokens = info.usage?.total ?? ((info.usage?.input ?? 0) + (info.usage?.output ?? 0));
  if (tokens) meta.push(`${formatTokens(tokens)} tok`);
  return (
    <div className="border border-ctp-mauve/30 rounded-lg flex flex-col" data-testid="chat-subagent" data-status={info.status} data-subagent-id={info.subagentId}>
      <div className="flex items-center min-w-0">
        <button
          type="button"
          className="flex-1 flex items-center gap-2 h-[34px] px-3 text-[12.5px] text-left min-w-0"
          onClick={toggle}
          aria-expanded={open}
        >
          <AgentsIcon className="text-ctp-mauve" />
          <span className="font-semibold text-ctp-text flex-shrink-0">{info.name}</span>
          {(info.description || tool?.title) && <span className="text-ctp-subtext0 truncate min-w-0">{info.description ?? tool?.title}</span>}
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap">
            {info.status === 'running' && <Spin />}
            <span className={info.status === 'failed' ? 'text-ctp-error' : ''}>{SUB_STATUS[info.status]}</span>
            {meta.length > 0 && <span>· {meta.join(' · ')}</span>}
          </span>
        </button>
        {onOpenInMap && (
          <button
            type="button"
            onClick={() => onOpenInMap(info.subagentId)}
            className="h-[34px] px-2.5 text-[11.5px] text-ctp-overlay1 hover:text-ctp-text flex-shrink-0"
            aria-label={`Open ${info.name} in the agent map`}
            data-testid="chat-subagent-open-map"
          >
            Agent map
          </button>
        )}
      </div>
      {summary && summary.kind === 'agent_message' && !open && (
        <div className="px-3 pb-2.5 pl-9 text-[12.5px] text-ctp-subtext0 line-clamp-3">{summary.text}</div>
      )}
      {open && (
        <div className="px-3 pb-2.5 pl-9 flex flex-col gap-1.5">
          {children.map((c) => {
            if (c.kind === 'tool_call') return <ToolRow key={c.id} tool={c} />;
            if (c.kind === 'agent_message') return <AgentMessage key={c.id} item={c} />;
            if (c.kind === 'thought') return <ThoughtRow key={c.id} item={c} />;
            return null;
          })}
        </div>
      )}
    </div>
  );
}
