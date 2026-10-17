/**
 * Small pieces shared by the sleeping, headless and finished quick-agent views
 * (#2019): the 32px toolbar with a status dot and one word, chrome buttons,
 * section heads and file rows with diff sizes.
 *
 * Buttons come from components/Button (#2014).
 */

import type { ReactNode } from 'react';
import { OrchestratorGlyph } from '../pane/AgentPaneToolbar';
import { DOT_LABEL, StatusDot, type AgentDot } from '../agent-status';
import { splitPath } from './format';

/** The states these views show, in the app's one status vocabulary (agent-status.tsx, #2018). */
export type StateDotKind = 'working' | 'needs' | 'error' | 'sleeping' | 'done';

const TO_DOT: Record<StateDotKind, AgentDot> = {
  working: 'working',
  needs: 'needs',
  error: 'error',
  sleeping: 'sleeping',
  done: 'idle',
};

export function StateDot({ kind }: { kind: StateDotKind }) {
  return <StatusDot dot={TO_DOT[kind]} />;
}

/** The pane toolbar: status dot, one word and a detail on the left, actions on the right. */
export function StateToolbar({ status, detail, right, testId }: {
  status: StateDotKind;
  detail?: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="h-8 flex-shrink-0 flex items-center gap-2 pl-3.5 pr-1.5 border-b border-surface-0 bg-ctp-base text-xs text-ctp-overlay1 min-w-0"
      data-testid={testId}
    >
      <StateDot kind={status} />
      <span className="text-ctp-text" data-testid="state-word">{DOT_LABEL[TO_DOT[status]]}</span>
      {detail && <span className="truncate min-w-0">{detail}</span>}
      {right && <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">{right}</div>}
    </div>
  );
}

/** Provider glyph and model, as the toolbar and composer show them. */
export function ModelLabel({ orchestrator, model }: { orchestrator?: string; model?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ctp-overlay1 whitespace-nowrap">
      <OrchestratorGlyph orchestrator={orchestrator || 'claude-code'} />
      <span>{model && model !== 'default' ? model : 'default model'}</span>
    </span>
  );
}

export function ToolbarSeparator() {
  return <span className="w-px h-4 mx-1 bg-surface-0 flex-shrink-0" aria-hidden="true" />;
}

export function SectionHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="h-7 flex items-center gap-2 text-xs">
      <span className="font-semibold text-ctp-overlay1">{title}</span>
      {right && <span className="ml-auto text-ctp-overlay1 tabular-nums">{right}</span>}
    </div>
  );
}

/** "+94 −89" in success / error. Either side may be absent. */
export function DiffStat({ added, removed }: { added?: number; removed?: number }) {
  const a = added ? `+${added}` : '';
  const r = removed ? `−${removed}` : '';
  if (!a && !r) return null;
  return (
    <span className="font-mono text-[11.5px] tabular-nums whitespace-nowrap">
      {a && <span className="text-ctp-success">{a}</span>}
      {a && r && ' '}
      {r && <span className="text-ctp-error">{r}</span>}
    </span>
  );
}

export function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

export function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-6 4-12 8" />
    </svg>
  );
}

/** One changed file: icon, file name, its directory, and the diff size. */
export function FileRow({ path, added, removed, binary, height = 28, onClick, selected }: {
  path: string;
  added?: number;
  removed?: number;
  binary?: boolean;
  height?: 28 | 30;
  onClick?: () => void;
  selected?: boolean;
}) {
  const { name, dir } = splitPath(path);
  const cls = `w-full flex items-center gap-2 px-2 -mx-2 rounded-md text-left min-w-0 ${height === 30 ? 'h-[30px]' : 'h-7'} ${
    selected ? 'bg-surface-0' : onClick ? 'hover:bg-surface-0' : ''
  }`;
  const body = (
    <>
      <span className="flex-shrink-0 text-ctp-overlay1 flex"><FileIcon /></span>
      <span className="flex-shrink-0 text-[13px] text-ctp-text">{name}</span>
      {dir && <span className="text-xs text-ctp-overlay1 truncate min-w-0">{dir}</span>}
      <span className="ml-auto flex-shrink-0 pl-2">
        {binary ? <span className="text-xs text-ctp-overlay1">binary</span> : <DiffStat added={added} removed={removed} />}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className={`${cls} cursor-pointer focus-ring`} onClick={onClick} title={path} data-testid="file-row">{body}</button>
  ) : (
    <div className={cls} title={path} data-testid="file-row">{body}</div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-surface-1 bg-ctp-mantle text-[10.5px] leading-none font-medium text-ctp-overlay1 font-sans">
      {children}
    </kbd>
  );
}
