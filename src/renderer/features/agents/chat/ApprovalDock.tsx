/**
 * Approvals live in the composer (docs/structured-chat-research.md, UI): a
 * pending permission request or question replaces the composer. Every button
 * is one of the provider's own options; Clubhouse never offers an answer the
 * CLI can't enforce, and requests wait for the user (no client-side timeout).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatQuestion, ChatQuestionAnswers, PermissionOption } from '../../../../shared/chat';
import type { PendingPermission, PendingQuestion, PlanDocumentItem } from '../../../stores/chatStore';
import { PlanIcon, QuestionIcon, ShieldIcon } from './icons';

const ALLOW_KINDS = new Set<PermissionOption['kind']>(['allow_once', 'allow_session', 'allow_always']);
const REJECT_KINDS = new Set<PermissionOption['kind']>(['reject_once', 'reject_always', 'cancel_turn']);

/** Enter picks the first one-time allow (or any allow); Esc the first one-time reject (or any reject). */
export function defaultOptions(options: PermissionOption[]): { primary?: PermissionOption; reject?: PermissionOption } {
  const primary = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => ALLOW_KINDS.has(o.kind));
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => REJECT_KINDS.has(o.kind));
  return { primary, reject };
}

function Key({ children }: { children: string }) {
  return <span className="ml-auto text-[11px] leading-none opacity-70 border border-current rounded px-1 py-0.5">{children}</span>;
}

interface PermissionCardProps {
  request: PendingPermission;
  /** Set when the request approves a plan document. */
  plan?: PlanDocumentItem;
  queueSize: number;
  onRespond: (requestId: string, optionId: string) => void;
}

export function PermissionCard({ request, plan, queueSize, onRespond }: PermissionCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [answered, setAnswered] = useState(false);
  const { primary, reject } = useMemo(() => defaultOptions(request.options), [request.options]);

  useEffect(() => {
    setAnswered(false);
    ref.current?.focus();
  }, [request.requestId]);

  const choose = (opt: PermissionOption | undefined) => {
    if (!opt || answered) return;
    setAnswered(true);
    onRespond(request.requestId, opt.optionId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { e.preventDefault(); choose(primary); return; }
    if (e.key === 'Escape') { e.preventDefault(); choose(reject); return; }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= request.options.length) {
      e.preventDefault();
      choose(request.options[n - 1]);
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
      {request.description && <div className="text-[12.5px] text-ctp-subtext0 pl-6 break-words">{request.description}</div>}
      <div className="flex flex-col gap-0.5 pl-5">
        {request.options.map((opt, i) => {
          const isPrimary = opt === primary;
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={answered}
              onClick={() => choose(opt)}
              className={`flex items-center gap-2.5 h-[30px] px-2 rounded-md text-[12.5px] text-left disabled:opacity-50 ${isPrimary ? 'bg-surface-0 text-ctp-text ring-1 ring-surface-1' : 'text-ctp-subtext1 hover:bg-surface-0/60'}`}
              data-option-kind={opt.kind}
            >
              <span className="w-[18px] h-[18px] rounded bg-ctp-crust grid place-items-center text-[11px] text-ctp-overlay1 flex-shrink-0">{i + 1}</span>
              <span className="truncate">{opt.label}</span>
              {opt.scope && <span className="font-mono text-[11px] text-ctp-overlay1 truncate">{opt.scope}</span>}
              {isPrimary && <Key>⏎</Key>}
              {opt === reject && <Key>Esc</Key>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface QuestionCardProps {
  request: PendingQuestion;
  onAnswer: (requestId: string, answers: ChatQuestionAnswers) => void;
}

function isSimpleChoice(q: ChatQuestion): boolean {
  return !q.multiSelect && !q.allowFreeText && (q.options?.length ?? 0) > 0;
}

export function QuestionCard({ request, onAnswer }: QuestionCardProps) {
  const [answers, setAnswers] = useState<ChatQuestionAnswers>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const single = request.questions.length === 1 && isSimpleChoice(request.questions[0]);

  const submit = (override?: ChatQuestionAnswers) => {
    if (sent) return;
    const merged: ChatQuestionAnswers = { ...answers, ...override };
    for (const q of request.questions) {
      const text = free[q.id]?.trim();
      if (text && merged[q.id] === undefined) merged[q.id] = text;
    }
    setSent(true);
    onAnswer(request.requestId, merged);
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

  return (
    <div className="rounded-xl border border-ctp-accent/50 bg-ctp-mantle px-3.5 py-3 flex flex-col gap-3" data-testid="chat-question" role="group" aria-label="Question">
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
