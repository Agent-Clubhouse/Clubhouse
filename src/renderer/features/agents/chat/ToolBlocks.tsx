import { useMemo, useState, type ReactNode } from 'react';
import type { ToolCallContent, ToolKind } from '../../../../shared/chat';
import type { ToolCallItem } from '../../../stores/chatStore';
import type { SubagentBlock } from './view-model';
import {
  commandOf,
  diffContent,
  diffLines,
  diffStats,
  exploreLabel,
  formatDuration,
  formatTokens,
  terminalContent,
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
  return (
    <div className="flex flex-col" data-testid="chat-tool-row" data-status={tool.status}>
      <div className={`flex items-center gap-2 min-w-0 text-[12.5px] text-ctp-overlay1 ${pending ? 'h-[30px] px-2 rounded-md bg-surface-0/60' : 'h-6'}`}>
        <Ico className="text-ctp-overlay1" />
        <span className="font-medium text-ctp-subtext1 flex-shrink-0">{KIND_VERBS[tool.toolKind]}</span>
        <span className="font-mono text-[11.5px] text-ctp-subtext0 truncate min-w-0" title={target}>{target}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap"><StatusMeta tool={tool} /></span>
      </div>
      {tool.error && <div className="ml-6 text-[12px] text-ctp-error break-words">{tool.error}</div>}
    </div>
  );
}

export function ExploreGroup({ tools }: { tools: ToolCallItem[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.status === 'in_progress');
  return (
    <div className="flex flex-col" data-testid="chat-explore-group">
      <button
        type="button"
        className="flex items-center gap-2 h-6 text-[12.5px] text-left text-ctp-overlay1 hover:text-ctp-subtext0"
        onClick={() => setOpen((o) => !o)}
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

export function DiffCard({ diff, line, status }: { diff: Extract<ToolCallContent, { type: 'diff' }>; line?: number; status?: ToolCallItem['status'] }) {
  const lines = useMemo(() => diffLines(diff, line), [diff, line]);
  const { added, removed } = useMemo(() => diffStats(lines), [lines]);
  const [expanded, setExpanded] = useState(false);
  const created = diff.oldText === undefined && !diff.unifiedDiff;
  const deleted = diff.newText === undefined && !diff.unifiedDiff && diff.oldText !== undefined;
  const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="chat-diff-card">
      <div className="flex items-center gap-2 h-[34px] px-3 border-b border-surface-0 text-[12.5px] text-ctp-overlay1 min-w-0">
        <EditIcon />
        {(created || deleted) && <span className="text-ctp-subtext0">{created ? 'Created' : 'Deleted'}</span>}
        <span className="font-mono text-[11.5px] text-ctp-text truncate min-w-0" title={diff.path}>{diff.path}</span>
        <span className="font-mono text-[11.5px] text-ctp-success">+{added}</span>
        <span className="font-mono text-[11.5px] text-ctp-error">−{removed}</span>
        {status === 'pending' && <span className="ml-auto text-[11.5px] text-ctp-warning">waiting for approval</span>}
        {status === 'failed' && <span className="ml-auto text-[11.5px] text-ctp-error">failed</span>}
      </div>
      <DiffBody lines={shown} />
      {lines.length > DIFF_PREVIEW_LINES && (
        <button type="button" className="w-full text-[11.5px] text-ctp-overlay1 hover:text-ctp-text py-1 border-t border-surface-0" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** Output lines kept visible; older lines scroll inside the card. */
const OUTPUT_MAX_HEIGHT = 'max-h-56';

export function CommandCard({ tool }: { tool: ToolCallItem }) {
  // Output arrives in many appended chunks; join them only when they change.
  const term = useMemo(() => terminalContent(tool), [tool]);
  const command = useMemo(() => commandOf(tool), [tool]);
  const running = tool.status === 'in_progress';
  const exit = term?.exitCode;
  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="chat-command-card" data-status={tool.status}>
      <div className="flex items-center gap-2 h-[34px] px-3 border-b border-surface-0 text-[12.5px] text-ctp-overlay1 min-w-0">
        <TerminalIcon />
        <span className="font-mono text-[11.5px] text-ctp-text truncate min-w-0" title={command}>$ {command}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ctp-overlay0 whitespace-nowrap">
          {running ? <><Spin /> running</>
            : tool.status === 'pending' ? <span className="text-ctp-warning">waiting for approval</span>
              : exit !== undefined ? <><span className={exit === 0 ? 'text-ctp-success font-mono' : 'text-ctp-error font-mono'}>exit {exit}</span>{tool.durationMs !== undefined && <span>· {formatDuration(tool.durationMs)}</span>}</>
                : <StatusMeta tool={tool} />}
        </span>
      </div>
      {term && term.output && (
        <pre className={`font-mono text-[11.5px] leading-[1.65] text-ctp-subtext0 px-3 py-2 bg-ctp-crust whitespace-pre-wrap break-words overflow-y-auto ${OUTPUT_MAX_HEIGHT} m-0`}>
          {term.output.replace(/\n$/, '')}
        </pre>
      )}
      {tool.error && <div className="px-3 py-1.5 text-[12px] text-ctp-error border-t border-surface-0">{tool.error}</div>}
    </div>
  );
}

/** One tool call: a diff card per file edit, a command card for commands, a row otherwise. */
export function ToolCallView({ tool }: { tool: ToolCallItem }) {
  const diffs = diffContent(tool);
  if (diffs.length > 0) {
    return (
      <>
        {diffs.map((d, i) => <DiffCard key={`${d.path}:${i}`} diff={d} line={tool.locations?.[0]?.line} status={tool.status} />)}
        {tool.error && <div className="text-[12px] text-ctp-error">{tool.error}</div>}
      </>
    );
  }
  if (tool.toolKind === 'execute' || tool.content.some((c) => c.type === 'terminal')) return <CommandCard tool={tool} />;
  const text = tool.content.find((c): c is Extract<ToolCallContent, { type: 'text' }> => c.type === 'text');
  return (
    <>
      <ToolRow tool={tool} />
      {text && tool.toolKind !== 'read' && (
        <div className="ml-6 text-[12px] text-ctp-subtext0 whitespace-pre-wrap break-words line-clamp-6">{text.text}</div>
      )}
    </>
  );
}

const SUB_STATUS: Record<SubagentBlock['info']['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function SubagentCard({ block }: { block: SubagentBlock }) {
  const [open, setOpen] = useState(false);
  const { info, tool, children } = block;
  const toolCount = info.toolCount ?? children.filter((c) => c.kind === 'tool_call').length;
  const summary = [...children].reverse().find((c) => c.kind === 'agent_message');
  const meta: string[] = [];
  if (toolCount) meta.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  if (tool?.durationMs !== undefined) meta.push(formatDuration(tool.durationMs));
  const tokens = info.usage?.total ?? ((info.usage?.input ?? 0) + (info.usage?.output ?? 0));
  if (tokens) meta.push(`${formatTokens(tokens)} tok`);
  return (
    <div className="border border-ctp-mauve/30 rounded-lg flex flex-col" data-testid="chat-subagent" data-status={info.status}>
      <button
        type="button"
        className="flex items-center gap-2 h-[34px] px-3 text-[12.5px] text-left min-w-0"
        onClick={() => setOpen((o) => !o)}
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
