/**
 * The Dispatcher's chat before its first message (#3048): it introduces
 * itself in its own voice, then offers a few things to say. Picking one sends
 * it as the user's message. The words come from shared/dispatcher-teaching;
 * "What else can you do?" is answered by the Dispatcher from its live grants
 * (the list_abilities tool), so this view never lists abilities itself.
 *
 * It sits in the chat stream's empty state, so the group chat's message list
 * (#3043) and the composer (#3045) are untouched. Reading what to show sends
 * nothing and starts nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDispatcherSuggestions, dispatcherIntro,
  type DispatcherSuggestion, type DispatcherTeaching,
} from '../../../shared/dispatcher-teaching';
import { onAgentCardChanged } from './agent-card-client';
import { useDispatcherStore } from './dispatcherStore';

export function readDispatcherTeaching(): Promise<DispatcherTeaching> {
  return window.clubhouse.dispatcher.getTeaching();
}

/**
 * The connected agents the intro counts and the suggestions name. Read again
 * when an agent's card changes and when the Dispatcher's state does (an agent
 * connecting or disconnecting changes its wires). Null until the first read;
 * a failed read reads as no agents.
 */
export function useDispatcherTeaching(): DispatcherTeaching | null {
  const [teaching, setTeaching] = useState<DispatcherTeaching | null>(null);
  const [nonce, setNonce] = useState(0);
  const dispatcherState = useDispatcherStore((s) => s.state);
  const seq = useRef(0);

  useEffect(() => onAgentCardChanged(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    const mine = ++seq.current;
    Promise.resolve().then(readDispatcherTeaching).then(
      (read) => { if (mine === seq.current) setTeaching(read ?? { agents: [] }); },
      // telemetry-exempt: the intro says no agents are connected, and the suggestions name none.
      () => { if (mine === seq.current) setTeaching({ agents: [] }); },
    );
  }, [nonce, dispatcherState]);

  return teaching;
}

export interface DispatcherIntroProps {
  /** The Dispatcher's name, as the user set it. */
  name: string;
  /** Null while the first read is out: the intro waits rather than say a wrong count. */
  teaching: DispatcherTeaching | null;
  /** Sends the picked suggestion as the user's message. */
  onPick: (text: string) => void;
  /** The composer can't send (the session ended, or it is loading). */
  disabled?: boolean;
}

export function DispatcherIntro({ name, teaching, onPick, disabled = false }: DispatcherIntroProps) {
  const intro = useMemo(() => (teaching ? dispatcherIntro({ name, reachable: teaching.agents.length }) : null), [name, teaching]);
  const suggestions = useMemo<DispatcherSuggestion[]>(() => (teaching ? buildDispatcherSuggestions(teaching.agents) : []), [teaching]);
  if (!intro) return <div className="py-10" data-testid="dispatcher-intro-loading" aria-busy="true" />;

  return (
    <div className="w-full max-w-[740px] self-center flex flex-col gap-4 py-6" data-testid="dispatcher-intro">
      <div className="text-[13.5px] leading-relaxed text-ctp-text">
        <div className="text-[12px] font-medium text-ctp-subtext1 mb-0.5">{name}</div>
        {intro.map((line) => <p key={line} className="m-0 mb-2 last:mb-0">{line}</p>)}
      </div>
      <div className="flex flex-col items-start gap-1.5" role="group" aria-label="Things to ask" data-testid="dispatcher-suggestions">
        <div className="text-[12px] text-ctp-subtext0">Try asking</div>
        {/* Outlined like a button, with a send arrow, so each reads as something to click (#3184). */}
        {suggestions.map((s) => (
          <button
            key={s.kind + s.text}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s.text)}
            className="group max-w-full inline-flex items-center gap-2 text-left text-[13px] text-ctp-text pl-3 pr-2.5 py-1.5 rounded-md border border-surface-1 bg-ctp-mantle cursor-pointer hover:bg-surface-0 hover:border-surface-2 focus-ring disabled:opacity-50 disabled:cursor-default disabled:hover:bg-ctp-mantle disabled:hover:border-surface-1"
            data-testid="dispatcher-suggestion"
            data-kind={s.kind}
          >
            <span className="min-w-0">{s.text}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-ctp-overlay1 group-hover:text-ctp-text" aria-hidden="true" data-testid="dispatcher-suggestion-arrow">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

/** DispatcherIntro reading its agents from main. */
export function DispatcherChatIntro(props: Omit<DispatcherIntroProps, 'teaching'>) {
  const teaching = useDispatcherTeaching();
  return <DispatcherIntro {...props} teaching={teaching} />;
}
