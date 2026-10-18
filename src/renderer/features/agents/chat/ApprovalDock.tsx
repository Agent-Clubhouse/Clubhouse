/**
 * Approvals live in the composer (docs/structured-chat-research.md, UI): a
 * pending permission request or question replaces the composer. Every button
 * is one of the provider's own options; Clubhouse never offers an answer the
 * CLI can't enforce, and requests wait for the user (no client-side timeout).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatCapabilities, ChatQuestion, ChatQuestionAnswers, PermissionOption, PermissionResponseExtras, ToolCallContent } from '../../../../shared/chat';
import type { PendingPermission, PendingQuestion, PlanDocumentItem } from '../../../stores/chatStore';
import { PlanIcon, QuestionIcon, ShieldIcon } from './icons';
import { ApprovalDiffPreview } from './ToolBlocks';

const ALLOW_KINDS = new Set<PermissionOption['kind']>(['allow_once', 'allow_session', 'allow_always']);
const REJECT_KINDS = new Set<PermissionOption['kind']>(['reject_once', 'reject_always', 'cancel_turn']);

/** Enter picks the first one-time allow (or any allow); Esc the first one-time reject (or any reject). */
export function defaultOptions(options: PermissionOption[]): { primary?: PermissionOption; reject?: PermissionOption } {
  const primary = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => ALLOW_KINDS.has(o.kind));
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => REJECT_KINDS.has(o.kind));
  return { primary, reject };
}

/** Keys typed into a text field or a focused control's own Enter/Space stay with that element. */
function ownsKey(e: KeyboardEvent<HTMLElement>): boolean {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return true;
  return t !== e.currentTarget && t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ');
}

/** 1-9 as an option index, or -1. */
function digitIndex(key: string, count: number): number {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : -1;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The approval's edited tool input: the request's input with `plan` replaced,
 * the shape plan-approval tools take (Claude's ExitPlanMode `{ plan }`).
 */
export function editedPlanInput(rawInput: unknown, plan: string): Record<string, unknown> {
  return { ...(isRecord(rawInput) ? rawInput : {}), plan };
}

function Key({ children }: { children: string }) {
  return <span className="ml-auto text-[11px] leading-none opacity-70 border border-current rounded px-1 py-0.5">{children}</span>;
}

interface PermissionCardProps {
  request: PendingPermission;
  /** Set when the request approves a plan document. */
  plan?: PlanDocumentItem;
  queueSize: number;
  agentName: string;
  /** What the driver can carry with an answer; absent means option ids only. */
  extras?: ChatCapabilities['permissionExtras'];
  /** Resolves false when the answer didn't go through; the card unlocks so the user can retry. */
  onRespond: (requestId: string, optionId: string, extras?: PermissionResponseExtras) => Promise<boolean>;
  /** An answer is already in flight, possibly from another view of this agent. */
  busy?: boolean;
  /** File changes the request's tool call would make; shown only when the request carries no content of its own. */
  diffs?: DiffContent[];
  /** The command the request would run (commandForRequest), shown when the request carries no content of its own. */
  command?: string;
}

type DiffContent = Extract<ToolCallContent, { type: 'diff' }>;

export function PermissionCard({ request, plan, queueSize, agentName, extras, onRespond, busy, diffs, command }: PermissionCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [answeredHere, setAnswered] = useState(false);
  const answered = answeredHere || !!busy;
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  const [planText, setPlanText] = useState(plan?.markdown ?? '');
  const { primary, reject } = useMemo(() => defaultOptions(request.options), [request.options]);
  const canFeedback = !!extras?.denyMessage && !!reject;
  const canEditPlan = !!extras?.updatedInput && !!plan;
  const planEdited = canEditPlan && planText.trim() !== '' && planText !== plan!.markdown;
  // A cleared editor can't be approved: it would silently approve the original plan.
  const planEmpty = canEditPlan && editing && planText.trim() === '';
  // With unsent text in the card, shortcuts on the card would throw it away, so they pause.
  const dirty = (canFeedback && feedback.trim() !== '') || planEdited;
  const editor = useRef<HTMLTextAreaElement>(null);
  // One preview: what the request itself carries (#2159), else the linked tool call's diffs. Never both.
  const hasContent = !!request.content?.length;
  const previewDiffs = useMemo<DiffContent[]>(
    () => (hasContent ? request.content!.filter((c): c is DiffContent => c.type === 'diff') : plan ? [] : diffs ?? []),
    [hasContent, request.content, plan, diffs],
  );
  const previewTexts = useMemo(() => {
    if (!hasContent) return command ? [command] : [];
    return request.content!.flatMap((c) => (c.type === 'text' ? [c.text] : c.type === 'terminal' && c.command ? [c.command] : []));
  }, [hasContent, request.content, command]);
  // Claude often sends the same sentence as title and description: say it once.
  const description = request.description && request.description.trim() !== request.title.trim() ? request.description : undefined;

  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);

  useEffect(() => {
    setAnswered(false);
    ref.current?.focus();
  }, [request.requestId]);

  /** Extras for this option: the feedback with a rejection, the edited plan with an approval. */
  const extrasFor = (opt: PermissionOption): PermissionResponseExtras | undefined => {
    if (canFeedback && REJECT_KINDS.has(opt.kind) && feedback.trim()) return { message: feedback.trim() };
    if (planEdited && ALLOW_KINDS.has(opt.kind)) return { updatedInput: editedPlanInput(request.rawInput, planText) };
    return undefined;
  };

  const choose = (opt: PermissionOption | undefined) => {
    if (!opt || answered) return;
    if (planEmpty && ALLOW_KINDS.has(opt.kind)) return;
    setAnswered(true);
    const sent = extrasFor(opt);
    void (sent ? onRespond(request.requestId, opt.optionId, sent) : onRespond(request.requestId, opt.optionId)).then((ok) => {
      if (!ok) {
        setAnswered(false);
        ref.current?.focus();
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (ownsKey(e) || dirty) return;
    if (e.key === 'Enter') { e.preventDefault(); choose(primary); return; }
    if (e.key === 'Escape') { e.preventDefault(); choose(reject); return; }
    const i = digitIndex(e.key, request.options.length);
    if (i >= 0) {
      e.preventDefault();
      choose(request.options[i]);
    }
  };

  const Ico = plan ? PlanIcon : ShieldIcon;
  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Permission request"
      className={`rounded-xl border ${plan ? 'border-ctp-accent/50' : 'border-ctp-warning/55'} bg-ctp-mantle px-3.5 py-3 flex flex-col gap-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-ctp-accent/60`}
      data-testid="chat-permission"
      data-request-id={request.requestId}
    >
      <div className="flex items-center gap-2.5 font-semibold text-[13.5px] text-ctp-text min-w-0">
        <Ico className={plan ? 'text-ctp-accent' : 'text-ctp-warning'} />
        <span className="break-words min-w-0">{request.title}</span>
        {queueSize > 1 && <span className="ml-auto text-[11.5px] font-normal text-ctp-overlay1 whitespace-nowrap">1 of {queueSize}</span>}
      </div>
      {/* Paths read best in monospace; the prose reasons Claude and Codex send don't. A request with a preview lists paths. */}
      {description && <div className={`text-[12.5px] text-ctp-subtext0 pl-6 break-words ${hasContent ? 'font-mono' : ''}`} data-testid="chat-permission-description">{description}</div>}
      {(previewDiffs.length > 0 || previewTexts.length > 0) && (
        <div className="pl-6 flex flex-col gap-1.5" data-testid="chat-permission-preview">
          <ApprovalDiffPreview diffs={previewDiffs} />
          {previewTexts.map((text, i) => (
            <pre key={i} className="max-h-40 overflow-auto rounded-md bg-ctp-crust px-2.5 py-2 font-mono text-[11.5px] text-ctp-subtext1 whitespace-pre-wrap break-words" data-testid="chat-permission-text">{text}</pre>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-0.5 pl-5">
        {request.options.map((opt, i) => {
          const isPrimary = opt === primary;
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={answered || (planEmpty && ALLOW_KINDS.has(opt.kind))}
              onClick={() => choose(opt)}
              className={`flex items-center gap-2.5 h-[30px] px-2 rounded-md text-[12.5px] text-left disabled:opacity-50 ${isPrimary ? 'bg-surface-0 text-ctp-text ring-1 ring-surface-1' : 'text-ctp-subtext1 hover:bg-surface-0/60'}`}
              data-option-kind={opt.kind}
            >
              <span className="w-[18px] h-[18px] rounded bg-ctp-crust grid place-items-center text-[11px] text-ctp-overlay1 flex-shrink-0">{i + 1}</span>
              <span className="truncate">{opt.label}</span>
              {opt.scope && <span className="font-mono text-[11px] text-ctp-overlay1 truncate">{opt.scope}</span>}
              {!dirty && isPrimary && <Key>⏎</Key>}
              {!dirty && opt === reject && <Key>Esc</Key>}
            </button>
          );
        })}
      </div>
      {canEditPlan && (
        <div className="pl-5 flex flex-col gap-1.5">
          {editing ? (
            <textarea
              ref={editor}
              value={planText}
              disabled={answered}
              onChange={(e) => setPlanText(e.target.value)}
              rows={Math.min(14, Math.max(4, planText.split('\n').length + 1))}
              aria-label="Edit the plan"
              className="w-full resize-y rounded-md border border-surface-1 bg-ctp-crust px-2.5 py-2 font-mono text-[12px] text-ctp-text focus:outline-none focus:border-ctp-accent/60"
            />
          ) : null}
          <div className="flex items-center gap-2 text-[12px] text-ctp-overlay1">
            <button
              type="button"
              disabled={answered}
              onClick={() => setEditing((v) => !v)}
              aria-expanded={editing}
              className="h-6 px-2 rounded-md bg-surface-0 text-ctp-subtext1 disabled:opacity-50"
            >
              {editing ? 'Hide plan editor' : 'Edit plan'}
            </button>
            {planEdited && <span>Approving sends your edited plan.</span>}
            {planEmpty && (
              <>
                <span className="text-ctp-warning" role="status">The plan is empty, so it can't be approved.</span>
                <button type="button" onClick={() => setPlanText(plan!.markdown)} className="h-6 px-2 rounded-md bg-surface-0 text-ctp-subtext1">
                  Restore original
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {canFeedback && (
        <input
          type="text"
          value={feedback}
          disabled={answered}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && feedback.trim()) { e.preventDefault(); choose(reject); }
          }}
          placeholder={plan ? `${reject!.label}, and tell ${agentName} what to change…` : `${reject!.label}, and tell ${agentName} what to do instead…`}
          aria-label={`${reject!.label} with a message`}
          className="ml-5 h-[30px] rounded-md border border-dashed border-surface-1 bg-transparent px-2.5 text-[12.5px] text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-solid focus:border-ctp-accent/60 disabled:opacity-50"
          data-testid="chat-permission-feedback"
        />
      )}
      {dirty && (
        <div className="pl-5 text-[11.5px] text-ctp-overlay1" data-testid="chat-permission-shortcuts-paused">
          Keyboard shortcuts are paused while you have unsent text. Choose an option to answer.
        </div>
      )}
    </div>
  );
}

interface QuestionCardProps {
  request: PendingQuestion;
  /** Resolves false when the answer didn't go through; the card unlocks so the user can retry. */
  onAnswer: (requestId: string, answers: ChatQuestionAnswers) => Promise<boolean>;
  /** An answer is already in flight, possibly from another view of this agent. */
  busy?: boolean;
}

function isSimpleChoice(q: ChatQuestion): boolean {
  return !q.multiSelect && !q.allowFreeText && (q.options?.length ?? 0) > 0;
}

export function QuestionCard({ request, onAnswer, busy }: QuestionCardProps) {
  const [answers, setAnswers] = useState<ChatQuestionAnswers>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [sentHere, setSent] = useState(false);
  const sent = sentHere || !!busy;
  const ref = useRef<HTMLDivElement>(null);
  const single = request.questions.length === 1 && isSimpleChoice(request.questions[0]);
  const first = request.questions[0];

  useEffect(() => {
    // Focus the card so number keys work at once; free text is a Tab away.
    ref.current?.focus();
  }, [request.requestId]);

  const submit = (override?: ChatQuestionAnswers) => {
    if (sent) return;
    const merged: ChatQuestionAnswers = { ...answers, ...override };
    for (const q of request.questions) {
      const text = free[q.id]?.trim();
      if (text && merged[q.id] === undefined) merged[q.id] = text;
    }
    setSent(true);
    void onAnswer(request.requestId, merged).then((ok) => { if (!ok) setSent(false); });
  };

  const complete = request.questions.every((q) => answers[q.id] !== undefined || !!free[q.id]?.trim());

  const toggle = (q: ChatQuestion, optionId: string) => {
    if (single) { submit({ [q.id]: optionId }); return; }
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.id]: optionId };
      const cur = Array.isArray(prev[q.id]) ? (prev[q.id] as string[]) : [];
      const next = cur.includes(optionId) ? cur.filter((x) => x !== optionId) : [...cur, optionId];
      return { ...prev, [q.id]: next };
    });
  };

  // 1-9 pick an option of the first question; Enter sends once every question is answered.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (sent || ownsKey(e)) return;
    if (e.key === 'Enter' && !single) {
      if (complete) { e.preventDefault(); submit(); }
      return;
    }
    const i = first?.options ? digitIndex(e.key, first.options.length) : -1;
    if (i >= 0) {
      e.preventDefault();
      toggle(first, first.options![i].id);
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-ctp-accent/50 bg-ctp-mantle px-3.5 py-3 flex flex-col gap-3 focus:outline-none"
      data-testid="chat-question"
      role="group"
      aria-label="Question"
    >
      {request.questions.map((q) => {
        const picked = answers[q.id];
        return (
          <div key={q.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5 font-semibold text-[13.5px] text-ctp-text">
              <QuestionIcon className="text-ctp-accent" />
              <span className="break-words min-w-0">{q.header ? `${q.header}: ` : ''}{q.prompt}</span>
            </div>
            {q.options && q.options.length > 0 && (
              <div className="flex flex-col gap-0.5 pl-5">
                {q.options.map((o, i) => {
                  const on = Array.isArray(picked) ? picked.includes(o.id) : picked === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={sent}
                      onClick={() => toggle(q, o.id)}
                      aria-pressed={on}
                      className={`flex items-center gap-2.5 min-h-[30px] px-2 rounded-md text-[12.5px] text-left disabled:opacity-50 ${on ? 'bg-surface-0 text-ctp-text ring-1 ring-surface-1' : 'text-ctp-subtext1 hover:bg-surface-0/60'}`}
                    >
                      <span className="w-[18px] h-[18px] rounded bg-ctp-crust grid place-items-center text-[11px] text-ctp-overlay1 flex-shrink-0">{i + 1}</span>
                      <span className="flex flex-col">
                        <span>{o.label}</span>
                        {o.description && <span className="text-[11.5px] text-ctp-overlay1">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {q.allowFreeText && (
              <input
                type="text"
                disabled={sent}
                value={free[q.id] ?? ''}
                onChange={(e) => setFree((f) => ({ ...f, [q.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && complete) { e.preventDefault(); submit(); } }}
                placeholder={q.options?.length ? 'Or type an answer…' : 'Type an answer…'}
                aria-label={`Answer: ${q.prompt}`}
                className="ml-5 h-[30px] rounded-md border border-surface-1 bg-transparent px-2.5 text-[12.5px] text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-accent/60"
              />
            )}
          </div>
        );
      })}
      {!single && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!complete || sent}
            onClick={() => submit()}
            className="h-7 px-3 rounded-md bg-ctp-accent text-ctp-crust text-[12px] font-medium disabled:opacity-40"
          >
            Send answer
          </button>
        </div>
      )}
    </div>
  );
}
