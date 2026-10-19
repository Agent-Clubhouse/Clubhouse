/**
 * The composer stays live while a turn runs. Enter steers when the driver can
 * steer, otherwise "Stop and send" (interrupt, then prompt); Shift+Enter
 * queues. Stop (Esc) interrupts the turn and keeps the session.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { CHAT_ATTACHMENTS_MAX, PERMISSION_LEVELS, type AvailableCommand, type ChatCapabilities, type ChatModelOption, type PermissionLevel } from '../../../../shared/chat';
import type { PlanEntry } from '../../../../shared/chat';
import type { QueuedMessage } from '../../../stores/chatStore';
import { CheckIcon, ChevronDown, FileIcon, PaperclipIcon, PlanIcon, PlusIcon, ShieldIcon, StopIcon, UpIcon, XIcon } from './icons';
import { attachmentFromFile, attachmentName, type ComposerAttachment } from './attachments';
import { composerModes, LEVEL_DESCRIPTIONS, LEVEL_LABELS, modelLabel, type SendAction } from './view-model';

const ACTION_LABELS: Record<SendAction, string> = {
  send: 'Send',
  steer: 'Steer',
  stop_and_send: 'Stop & send',
  queue: 'Queue',
};

function KeyHint({ children }: { children: string }) {
  return <span className="text-[11px] leading-none opacity-70 border border-current rounded px-1 py-0.5">{children}</span>;
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export function TaskList({ entries }: { entries: PlanEntry[] }) {
  const [open, setOpen] = useState(true);
  const done = entries.filter((e) => e.status === 'completed').length;
  const allDone = done === entries.length;
  return (
    <div className={`border border-surface-0 rounded-lg bg-ctp-mantle px-3 py-2 flex flex-col gap-1.5 ${allDone ? 'opacity-70' : ''}`} data-testid="chat-tasks">
      <button type="button" className="flex items-center gap-2 text-[12.5px] text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <PlanIcon className="text-ctp-overlay1" />
        <span className="font-semibold text-ctp-text">Tasks</span>
        <span className="text-ctp-overlay1 tabular-nums">{done}/{entries.length}</span>
        <ChevronDown className={`ml-auto text-ctp-overlay0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1 m-0 p-0 list-none">
          {entries.map((e, i) => (
            <li
              key={e.id ?? i}
              className={`flex items-center gap-1.5 text-[12px] ${e.status === 'completed' ? 'text-ctp-overlay0 line-through' : e.status === 'in_progress' ? 'text-ctp-text' : 'text-ctp-subtext0'}`}
              data-status={e.status}
            >
              {e.status === 'completed'
                ? <CheckIcon size={13} className="text-ctp-success" />
                : e.status === 'in_progress'
                  ? <span className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-surface-1 border-t-ctp-success animate-spin" />
                  : <span className="inline-block w-[11px] h-[11px] rounded-full border-[1.5px] border-surface-2" />}
              {e.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

export function QueueList({ queued }: { queued: QueuedMessage[] }) {
  return (
    <div className="border border-surface-0 rounded-lg bg-ctp-mantle flex flex-col overflow-hidden" data-testid="chat-queue">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] border-b border-surface-0">
        <span className="font-semibold text-ctp-text">Queued</span>
        <span className="text-ctp-overlay1">{queued.length} · sent when this turn ends</span>
      </div>
      {queued.map((q, i) => (
        <div key={q.messageId} className={`flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-ctp-subtext1 ${i > 0 ? 'border-t border-surface-0' : ''}`}>
          <span className="w-[18px] h-[18px] rounded bg-surface-0 grid place-items-center text-[11px] text-ctp-overlay1 flex-shrink-0">{i + 1}</span>
          <span className="truncate min-w-0">{q.text || queuedAttachmentLabel(q)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Level menu ──────────────────────────────────────────────────────────────

/** The permission level and its menu. The composer shows it; so does the approval dock, which replaces the composer while a request waits. */
export function LevelPill({ level, capabilities, levelNames, onChange, compact }: { level: PermissionLevel | null; capabilities: ChatCapabilities | null; levelNames?: Partial<Record<PermissionLevel, string>>; onChange: (l: PermissionLevel) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const live = capabilities?.liveLevels ?? [];
  const current = level ?? 'ask';
  // The driver's own levels, in ladder order; the current level stays listed even if it can't be re-entered live.
  const levels = PERMISSION_LEVELS.filter((l) => l === current || live.includes(l));
  const canChange = levels.some((l) => l !== current);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!canChange}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={compact ? `Permissions: ${LEVEL_LABELS[current]}` : canChange ? 'Permission level' : "This agent can't change permission level mid-session"}
        aria-label={compact ? `Permissions: ${LEVEL_LABELS[current]}` : undefined}
        className={`h-[26px] flex items-center gap-1.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] disabled:opacity-60 ${compact ? 'px-2' : 'px-2.5'}`}
        data-testid="chat-level-pill"
      >
        <ShieldIcon size={13} className="text-ctp-overlay1" />
        {!compact && LEVEL_LABELS[current]}
        {canChange && <ChevronDown className="text-ctp-overlay1" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 bottom-9 w-[300px] bg-ctp-crust border border-surface-1 rounded-lg shadow-xl p-1.5 z-dropdown flex flex-col gap-px"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[11.5px] font-semibold text-ctp-overlay1">Permissions</div>
          {levels.map((l) => {
            return (
              <button
                key={l}
                type="button"
                role="menuitemradio"
                aria-checked={l === current}
                onClick={() => { setOpen(false); if (l !== current) onChange(l); }}
                className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] text-ctp-text disabled:opacity-45 ${l === current ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
              >
                <span className={`w-3 h-3 rounded-full flex-shrink-0 ${l === current ? 'border-[3.5px] border-ctp-accent' : 'border-[1.5px] border-surface-2'}`} />
                <span className="flex flex-col">
                  <span>{LEVEL_LABELS[l]}</span>
                  <span className="text-[11px] text-ctp-overlay1">{LEVEL_DESCRIPTIONS[l]}</span>
                  {levelNames?.[l] && (
                    <span className="font-mono text-[10.5px] text-ctp-overlay0" data-testid={`chat-level-native-${l}`}>{levelNames[l]}</span>
                  )}
                </span>
                {l === 'full_access' && <span className="ml-auto text-[11px] text-ctp-error">no prompts</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Model menu ──────────────────────────────────────────────────────────────

const SWITCH_TIMING: Record<string, string> = {
  per_turn: 'from the next message',
  restart: 'the next time the agent starts',
};

/** When model and effort changes take effect; one sentence when they match. */
export function switchNote(modelSwitch: string, effortSwitch: string): string | undefined {
  const model = SWITCH_TIMING[modelSwitch];
  const effort = SWITCH_TIMING[effortSwitch];
  if (modelSwitch === effortSwitch || effortSwitch === 'none') return model ? `Applies ${model}.` : undefined;
  if (modelSwitch === 'none') return effort ? `Effort applies ${effort}.` : undefined;
  const parts = [
    model ? `Model changes apply ${model}` : 'Model changes apply now',
    effort ? `effort changes ${effort}` : 'effort changes now',
  ];
  return model || effort ? `${parts.join('; ')}.` : undefined;
}

/** Closes an open menu on any mousedown outside it (the menu stops its own). */
function useCloseOnMouseDown(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, close]);
}

// One line whatever the width (#2112): long names end in an ellipsis, with the full name in the tooltip.
// max-w-full keeps the button inside its shrinking wrapper, so the label truncates
// instead of spilling over the send buttons in a narrow composer (#2260).
const chipClass = 'h-[26px] min-w-0 max-w-full overflow-hidden flex items-center gap-1.5 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] whitespace-nowrap disabled:opacity-100 disabled:cursor-default';
// A pill never shrinks below a readable stub ("Hai…" and its chevron); the
// footer wraps the send buttons to their own row before anything overlaps.
const PILL_WRAP = 'relative min-w-[72px] max-w-[180px]';
const menuClass = 'absolute left-0 bottom-9 bg-ctp-crust border border-surface-1 rounded-lg shadow-xl p-1.5 z-dropdown flex flex-col gap-px';

function Radio({ on }: { on: boolean }) {
  return <span className={`w-3 h-3 rounded-full flex-shrink-0 ${on ? 'border-[3.5px] border-ctp-accent' : 'border-[1.5px] border-surface-2'}`} />;
}

function ModelPill({ models, efforts, model, effort, effortIsDefault, capabilities, onChange }: {
  models: ChatModelOption[];
  efforts: string[];
  model: string | null;
  effort: string | null;
  effortIsDefault?: boolean;
  capabilities: ChatCapabilities | null;
  onChange: (modelId: string, effort?: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnMouseDown(open, close);
  const modelSwitch = capabilities?.modelSwitch ?? 'none';
  const canChange = models.length > 0 && modelSwitch !== 'none';
  const current = models.find((m) => m.id === model);
  const label = model ? modelLabel(model, models) : model;
  if (!label) return null;
  // The exact id stays in the tooltip when the label is a friendlier name for it.
  const fullName = model && label !== model ? `${label} (${model})` : label;
  // Keep a chosen effort across a model switch if it's still on offer; a default one follows the new model's default.
  const keptEffort = effort && !effortIsDefault && efforts.includes(effort) ? effort : undefined;
  const note = switchNote(modelSwitch, 'none');

  return (
    <div className={PILL_WRAP}>
      <button
        type="button"
        disabled={!canChange}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={canChange ? fullName : `${fullName}. This agent can't change model mid-session.`}
        className={chipClass}
        data-testid="chat-model-pill"
      >
        <span className="truncate min-w-0">{label}</span>
        {canChange && <ChevronDown className="text-ctp-overlay1 flex-shrink-0" />}
      </button>
      {open && (
        <div role="menu" className={`${menuClass} w-[300px] max-h-[360px] overflow-y-auto`} onMouseDown={(e) => e.stopPropagation()} data-testid="chat-model-menu">
          <div className="px-2 py-1.5 text-[11.5px] font-semibold text-ctp-overlay1">Model</div>
          {models.map((m) => {
            const selected = m.id === current?.id;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => { setOpen(false); if (!selected) onChange(m.id, keptEffort); }}
                className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] text-ctp-text ${selected ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
              >
                <Radio on={selected} />
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{m.label}</span>
                  {m.description && <span className="text-[11px] text-ctp-overlay1 truncate">{m.description}</span>}
                </span>
                {m.costHint && <span className="ml-auto text-[11px] text-ctp-overlay1 whitespace-nowrap">{m.costHint}</span>}
              </button>
            );
          })}
          {note && <div className="px-2 pt-1.5 text-[11px] text-ctp-overlay1">{note}</div>}
        </div>
      )}
    </div>
  );
}

/** Sentence-case label for an effort id: "xhigh" → "Extra high"; other levels capitalised. */
export function effortWord(effort: string): string {
  if (effort === 'xhigh') return 'Extra high';
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

/** Reasoning effort for the current model (#2091); absent when the model has none. */
function EffortPill({ efforts, model, effort, effortIsDefault, effortReported = true, capabilities, onChange }: {
  efforts: string[];
  model: string | null;
  effort: string | null;
  /** `effort` is the provider's default level, not one chosen in the session. */
  effortIsDefault?: boolean;
  /** False while the session hasn't reported its effort yet. */
  effortReported?: boolean;
  capabilities: ChatCapabilities | null;
  /** null returns the effort to the provider's default. */
  onChange: (modelId: string, effort: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnMouseDown(open, close);
  const effortSwitch = capabilities?.effortSwitch ?? 'none';
  if (!efforts.length && !effort) return null;
  // Not reported yet: "Default effort" now would flash before the real level.
  if (!effortReported && effort === null) return null;
  const canChange = !!model && efforts.length > 0 && effortSwitch !== 'none';
  const note = switchNote('none', effortSwitch);
  // On the default the level still shows, since that's what applies.
  const onDefault = effort === null || !!effortIsDefault;
  // Without a Default row, the level the default resolved to is the checked one.
  const chosen = onDefault && capabilities?.effortDefault ? null : effort;
  const label = effort ? `${effortWord(effort)} effort${effortIsDefault ? ' (default)' : ''}` : 'Default effort';

  return (
    <div className={PILL_WRAP}>
      <button
        type="button"
        disabled={!canChange}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={canChange ? `Reasoning effort, ${effort ? effortWord(effort).toLowerCase() : 'the default'}` : "This agent can't change effort mid-session"}
        className={chipClass}
        data-testid="chat-effort-pill"
      >
        <span className="truncate min-w-0">{label}</span>
        {canChange && <ChevronDown className="text-ctp-overlay1 flex-shrink-0" />}
      </button>
      {open && model && (
        <div role="menu" className={`${menuClass} w-[220px]`} onMouseDown={(e) => e.stopPropagation()} data-testid="chat-effort-menu">
          <div className="px-2 py-1.5 text-[11.5px] font-semibold text-ctp-overlay1">Effort</div>
          {capabilities?.effortDefault && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={onDefault}
              onClick={() => { setOpen(false); if (!onDefault) onChange(model, null); }}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] text-ctp-text ${onDefault ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
              data-testid="chat-effort-default"
            >
              <Radio on={onDefault} />
              <span className="flex flex-col">
                <span>Default</span>
                <span className="text-[11px] text-ctp-overlay1">The model&apos;s own default</span>
              </span>
            </button>
          )}
          {efforts.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={e === chosen}
              // Choosing the level the default resolved to pins it, so it isn't a no-op.
              onClick={() => { setOpen(false); if (e !== chosen) onChange(model, e); }}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] text-ctp-text ${e === chosen ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
            >
              <Radio on={e === chosen} />
              <span>{effortWord(e)}</span>
              {/* The level the default resolved to, marked the same for every provider (#2181). */}
              {effortIsDefault && e === effort && <span className="ml-auto text-[11px] text-ctp-overlay1">default</span>}
            </button>
          ))}
          {note && <div className="px-2 pt-1.5 text-[11px] text-ctp-overlay1">{note}</div>}
        </div>
      )}
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

/** A `/word` being typed: starts the draft or follows whitespace, and runs up to the caret. */
export interface SlashToken {
  start: number;
  end: number;
  query: string;
}

/**
 * The slash command under the caret (#2090), anywhere in the draft. Paths and
 * URLs don't count: the slash has to open a word and the word has only the one.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const m = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const rest = /^[^\s]*/.exec(text.slice(caret))![0];
  if (rest.includes('/')) return null;
  return { start: m.index + m[1].length, end: caret + rest.length, query: m[2] };
}

export interface ComposerProps {
  agentName: string;
  capabilities: ChatCapabilities | null;
  running: boolean;
  disabled?: boolean;
  disabledReason?: string;
  level: PermissionLevel | null;
  model: string | null;
  effort: string | null;
  /** `effort` is the provider's default level rather than one chosen in the session. */
  effortIsDefault?: boolean;
  /**
   * False until the session reports its effort (model_changed): the effort
   * chip waits rather than showing "Default effort" first. Omitted: known.
   */
  effortReported?: boolean;
  /** Model choices from the driver; empty means the menu isn't offered. */
  models?: ChatModelOption[];
  /** Effort choices for the current model. */
  efforts?: string[];
  /** The provider's own name for each live level. */
  levelNames?: Partial<Record<PermissionLevel, string>>;
  commands: AvailableCommand[];
  /** The draft is owned by the caller so it outlives this component. */
  text: string;
  onTextChange: (text: string) => void;
  /** Agent the attachments are staged for; attaching is off without it. */
  attachmentAgentId?: string;
  /** Unsent attachments, owned by the caller like the text. */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (attachments: ComposerAttachment[]) => void;
  /** Staged attachment ids, only passed when there are some. */
  onSend: (text: string, action: SendAction, attachmentIds?: string[]) => void;
  onStop: () => void;
  onLevelChange: (level: PermissionLevel) => void;
  /** Omitted effort keeps the current one; null returns it to the provider's default (capabilities.effortDefault). */
  onModelChange?: (modelId: string, effort?: string | null) => void;
  /**
   * How much room there is (#2018): 'narrow' folds the permission pill to its
   * shield, 'line' (a popout near its minimum height) is one row with attach,
   * permissions and model under +.
   */
  layout?: ComposerLayout;
}

export type ComposerLayout = 'wide' | 'narrow' | 'line';

const NO_ATTACHMENTS: ComposerAttachment[] = [];

/** Queue row label for a message that's only attachments. */
function queuedAttachmentLabel(q: QueuedMessage): string {
  const names = q.content.map(attachmentName).filter((n): n is string => !!n);
  return names.length ? names.join(', ') : '';
}

/** Pending attachments above the text box. */
function AttachmentChips({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5" data-testid="chat-attachments">
      {attachments.map((a) => (
        <span key={a.id} className="h-8 max-w-[220px] flex items-center gap-1.5 pl-1 pr-1.5 rounded-md bg-surface-0 text-[12px] text-ctp-subtext1" data-testid="chat-attachment">
          {a.preview
            ? <img src={a.preview} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0" />
            : <FileIcon size={14} className="ml-1 text-ctp-overlay1 flex-shrink-0" />}
          <span className="truncate min-w-0" title={a.kind === 'file' ? `${a.name} (sent as a file path)` : a.name}>{a.name}</span>
          <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`} className="text-ctp-overlay1 hover:text-ctp-text flex-shrink-0">
            <XIcon size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function Composer(props: ComposerProps) {
  const { capabilities, running, disabled, text, onTextChange: setText } = props;
  const attachments = props.attachments ?? NO_ATTACHMENTS;
  const agentId = props.attachmentAgentId;
  const canAttach = !!props.onAttachmentsChange && !!agentId;
  const [cmdIndex, setCmdIndex] = useState(0);
  // The caret, tagged with the draft it was read from. The draft is owned by the
  // caller: when it changes from outside (a restored draft after a failed send,
  // another agent's draft), the caret is unknown until the user types or moves it,
  // so no menu opens on its own.
  const [caretAt, setCaretAt] = useState<{ text: string; at: number } | null>(null);
  const caret = caretAt?.text === text ? Math.min(caretAt.at, text.length) : null;
  // Where the slash was when Esc closed the menu; it stays closed for that word.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Adding files is async; keep the latest list so concurrent adds don't drop
  // each other, and count adds in flight so the cap holds across them.
  const latest = useRef(attachments);
  latest.current = attachments;
  const adding = useRef(0);
  const modes = composerModes(capabilities, running);
  const layout = props.layout ?? 'wide';
  const line = layout === 'line';
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, line ? 72 : 200)}px`;
  }, [text, line]);

  const slash = useMemo(
    () => (capabilities?.slashCommands && caret !== null ? slashTokenAt(text, caret) : null),
    [capabilities?.slashCommands, text, caret],
  );
  const slashMatches = useMemo(() => {
    if (!slash || slash.start === dismissedAt) return [];
    const q = slash.query.toLowerCase();
    // The CLI's own commands only run when the message starts with them (#2135).
    const atStart = text.slice(0, slash.start).trim() === '';
    return props.commands.filter((c) => (atStart || !c.startOnly) && c.name.toLowerCase().startsWith(q)).slice(0, 8);
  }, [slash, dismissedAt, props.commands, text]);

  useEffect(() => {
    if (dismissedAt !== null && slash?.start !== dismissedAt) setDismissedAt(null);
  }, [slash, dismissedAt]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !area.current) return;
    pendingCaret.current = null;
    area.current.setSelectionRange(at, at);
  }, [text]);

  useEffect(() => { setCmdIndex(0); }, [slashMatches.length]);

  const addFiles = async (files: File[]) => {
    if (!canAttach || !agentId || disabled || !files.length) return;
    // Reserve room synchronously, before any await.
    const room = Math.max(0, CHAT_ATTACHMENTS_MAX - latest.current.length - adding.current);
    const accepted = files.slice(0, room);
    adding.current += accepted.length;
    // Cleared now and set only on failure, so a concurrent add can't wipe another's message.
    setAttachError(null);
    const errors: string[] = [];
    if (files.length > room) errors.push(`Attach at most ${CHAT_ATTACHMENTS_MAX} files at a time`);
    const added: ComposerAttachment[] = [];
    try {
      for (const file of accepted) {
        const result = await attachmentFromFile(agentId, file, capabilities?.images === true);
        if ('error' in result) errors.push(result.error);
        else added.push(result);
      }
    } finally {
      adding.current -= accepted.length;
    }
    if (errors.length) setAttachError(errors.join('. '));
    if (added.length) props.onAttachmentsChange?.([...latest.current, ...added]);
  };

  const removeAttachment = (id: string) => {
    props.onAttachmentsChange?.(attachments.filter((a) => a.id !== id));
    setAttachError(null);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!canAttach || !files.length) return;
    e.preventDefault();
    void addFiles(files);
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach || disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach || disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };

  const submit = (action: SendAction) => {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || disabled) return;
    if (attachments.length) props.onSend(trimmed, action, attachments.map((a) => a.id));
    else props.onSend(trimmed, action);
    setText('');
    // A failed send restores this same text from outside; the caret read from it no longer counts.
    setCaretAt(null);
    if (attachments.length) props.onAttachmentsChange?.([]);
    setAttachError(null);
  };

  const pickCommand = (c: AvailableCommand) => {
    if (!slash) return;
    // Replace only the word being typed; keep one space after it.
    const after = text.slice(slash.end).replace(/^ /, '');
    const inserted = `/${c.name} `;
    const at = slash.start + inserted.length;
    const next = text.slice(0, slash.start) + inserted + after;
    setCaretAt({ text: next, at });
    area.current?.focus();
    if (next === text) {
      // Nothing re-renders the textarea, so place the caret now rather than after the next edit.
      area.current?.setSelectionRange(at, at);
      return;
    }
    pendingCaret.current = at;
    setText(next);
  };

  const trackCaret = (el: HTMLTextAreaElement) => setCaretAt({ text: el.value, at: el.selectionStart ?? el.value.length });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME is composing, its keys are its own: Enter commits, Esc cancels. None picks, sends or stops.
    if (e.nativeEvent.isComposing) return;
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % slashMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
      // Enter picks only once a name is started: "yes and /" sends as typed. Tab always picks.
      const enterPicks = e.key === 'Enter' && !e.shiftKey && !!slash?.query && slash.query !== slashMatches[cmdIndex].name;
      if (e.key === 'Tab' || enterPicks) {
        e.preventDefault();
        pickCommand(slashMatches[cmdIndex]);
        return;
      }
      // Esc closes the menu and leaves the text as typed; it doesn't stop the turn.
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(slash?.start ?? null);
        return;
      }
    }
    if (e.key === 'Escape' && modes.canStop) {
      e.preventDefault();
      props.onStop();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey) {
      // Shift+Enter queues during a turn; otherwise it's a newline.
      if (!modes.secondary) return;
      e.preventDefault();
      submit(modes.secondary);
      return;
    }
    e.preventDefault();
    submit(modes.primary);
  };

  const empty = !text.trim() && !attachments.length;
  const placeholder = disabled
    ? props.disabledReason ?? 'This session has ended'
    : `Message ${props.agentName}…${capabilities?.slashCommands ? ' / for commands' : ''}`;

  const tools = (
    <>
      {canAttach && (
        <>
          <button
            type="button"
            disabled={disabled || attachments.length >= CHAT_ATTACHMENTS_MAX}
            onClick={() => picker.current?.click()}
            aria-label="Attach files"
            title={capabilities?.images ? 'Attach images or files' : 'Attach files (this agent can\'t take images; they go as paths)'}
            className="w-[26px] h-[26px] rounded-md grid place-items-center text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 disabled:opacity-40"
            data-testid="chat-attach"
          >
            <PaperclipIcon size={14} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="chat-attach-input"
            onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
        </>
      )}
      <LevelPill level={props.level} capabilities={capabilities} levelNames={props.levelNames} onChange={props.onLevelChange} compact={layout === 'narrow'} />
      <ModelPill
        models={props.onModelChange ? props.models ?? [] : []}
        efforts={props.efforts ?? []}
        model={props.model}
        effort={props.effort}
        effortIsDefault={props.effortIsDefault}
        capabilities={capabilities}
        onChange={(m, e) => props.onModelChange?.(m, e)}
      />
      <EffortPill
        efforts={props.onModelChange ? props.efforts ?? [] : []}
        model={props.model}
        effort={props.effort}
        effortIsDefault={props.effortIsDefault}
        effortReported={props.effortReported}
        capabilities={capabilities}
        onChange={(m, e) => props.onModelChange?.(m, e)}
      />
    </>
  );

  const sendButtons = (
    <span className={`${line ? '' : 'ml-auto'} flex-shrink-0 flex items-center gap-1.5`}>
      {running ? (
        <>
          <button
            type="button"
            disabled={empty || disabled}
            onClick={() => submit(modes.primary)}
            className="h-7 flex items-center gap-1.5 px-2.5 rounded-md bg-ctp-accent text-ctp-crust text-[12px] font-medium disabled:opacity-40 whitespace-nowrap"
            data-testid="chat-send-primary"
          >
            {ACTION_LABELS[modes.primary]}{!line && <> <KeyHint>⏎</KeyHint></>}
          </button>
          {modes.secondary && (
            <button
              type="button"
              disabled={empty || disabled}
              onClick={() => submit(modes.secondary!)}
              className="h-7 flex items-center gap-1.5 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] font-medium disabled:opacity-40 whitespace-nowrap"
              data-testid="chat-send-secondary"
            >
              {ACTION_LABELS[modes.secondary]}{!line && <> <KeyHint>⇧⏎</KeyHint></>}
            </button>
          )}
          {modes.canStop && (
            <button
              type="button"
              onClick={props.onStop}
              title="Stop (Esc)"
              aria-label="Stop"
              className="w-[30px] h-[30px] rounded-lg bg-surface-1 text-ctp-text grid place-items-center"
              data-testid="chat-stop"
            >
              <StopIcon />
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          disabled={empty || disabled}
          onClick={() => submit('send')}
          aria-label="Send"
          className="w-[30px] h-[30px] rounded-lg bg-ctp-accent text-ctp-crust grid place-items-center disabled:opacity-40"
          data-testid="chat-send"
        >
          <UpIcon />
        </button>
      )}
    </span>
  );

  const textarea = (
    <textarea
      ref={area}
      rows={1}
      value={text}
      disabled={disabled}
      onChange={(e) => { trackCaret(e.target); setText(e.target.value); }}
      onSelect={(e) => trackCaret(e.currentTarget)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      placeholder={placeholder}
      aria-label="Message"
      className={`resize-none bg-transparent text-[13px] text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none ${
        line ? 'flex-1 min-w-0 px-1.5 py-1.5' : 'px-3.5 pt-3 pb-1.5 min-h-[44px]'
      }`}
    />
  );
  const attachErrorNote = attachError && <p className="px-3.5 pb-1 text-[11.5px] text-ctp-red" role="alert" data-testid="chat-attach-error">{attachError}</p>;

  return (
    <div className="relative">
      {slashMatches.length > 0 && (
        <div role="listbox" className="absolute left-0 bottom-full mb-1.5 w-[320px] bg-ctp-crust border border-surface-1 rounded-lg shadow-xl p-1 z-dropdown" data-testid="chat-slash-menu">
          {slashMatches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === cmdIndex}
              onMouseDown={(e) => { e.preventDefault(); pickCommand(c); }}
              className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left text-[12.5px] ${i === cmdIndex ? 'bg-surface-0' : ''}`}
            >
              <span className="font-mono text-ctp-text">/{c.name}</span>
              {c.description && <span className="text-[11.5px] text-ctp-overlay1 truncate">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      <div
        className={`border rounded-xl bg-ctp-mantle flex flex-col ${disabled ? 'border-surface-0 opacity-70' : dragging ? 'border-ctp-accent' : 'border-surface-1 focus-within:border-ctp-accent/60'}`}
        data-testid="chat-composer"
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          // Moving between children fires dragleave too; only leaving the composer counts.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <span className="sr-only" aria-live="polite">{dragging ? 'Drop files to attach them' : ''}</span>
        {dragging && <p className="px-3.5 pt-2.5 text-[12px] text-ctp-accent" data-testid="chat-drop-hint">Drop files to attach them</p>}
        {attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={removeAttachment} />}
        {line ? (
          <>
            {moreOpen && <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2" data-testid="chat-composer-more">{tools}</div>}
            <div className="flex items-center gap-1 pl-1 pr-1.5 py-1">
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                aria-label="Attach, permissions and model"
                title="Attach, permissions and model"
                className="w-7 h-7 flex-shrink-0 rounded-md grid place-items-center text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0"
                data-testid="chat-composer-plus"
              >
                <PlusIcon size={14} />
              </button>
              {textarea}
              {sendButtons}
            </div>
            {attachErrorNote}
          </>
        ) : (
          <>
            {textarea}
            {attachErrorNote}
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1.5" data-testid="chat-composer-footer">
              {tools}
              {sendButtons}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
