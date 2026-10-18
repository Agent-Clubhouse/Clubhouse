import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo, PluginAPI, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import {
  Button, PopupMenu, Toggle, useProjectStore, isRemoteAgentId, type MenuItem,
  useChromeStore, useChromeFlagStore, openNewAgentOrDialog, FOCUS_ACTIVE_TERMINAL_EVENT, StatusDot,
} from './host';
import { reviewNav } from './commands';
import { clampIndex, filterAgents, filterNeedsAttention, filterRemoteAgents, resolveIndex } from './filters';
import { browseAction, emptyCause, reviewDot, statusWord } from './reviewModel';
import { ReviewEmptyState } from './ReviewEmptyState';
import { SleepingCard, type SleepingCardHandle } from './SleepingCard';
import { Icon, Kbd, ReviewAvatar, Svg, useProjectName } from './reviewUi';
import { wakeAgent } from './wake';
import { reportChromeActionFailed } from '../../../chrome/telemetry';

/**
 * Review (#2021): one agent at a time behind a 32px toolbar, with a hint row
 * for the single keys that work while browsing. Return hands the keyboard to
 * the agent; ⌘← and ⌘→ move on and come back to browsing.
 */

/** The last app launch this view applied, so a remount doesn't reapply an old one. */
let appliedLaunchSeq = 0;

/** Fields and the jump list keep their keys; everything else in the view is browsing. */
const OWN_KEYS = 'input, textarea, select, [role="menu"], [role="dialog"], .xterm';
const ownsKeys = (el: HTMLElement) => el.isContentEditable || !!el.closest?.(OWN_KEYS);

/** Where an agent running in chat is typed to; the terminal's equivalent is .xterm. */
const COMPOSER = '[data-testid="chat-composer"] textarea';

type SlideDirection = 'left' | 'right' | null;

function SlideContainer({ agentId, slideDirection, onTransitionEnd, children }: {
  agentId: string;
  slideDirection: SlideDirection;
  onTransitionEnd: () => void;
  children?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<'entering' | 'settled'>('settled');
  const prevAgentId = useRef(agentId);

  useEffect(() => {
    if (agentId !== prevAgentId.current && slideDirection) {
      setPhase('entering');
      prevAgentId.current = agentId;
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase('settled')));
    } else {
      prevAgentId.current = agentId;
    }
  }, [agentId, slideDirection]);

  let transform = 'translateX(0)';
  let transition = 'transform 300ms ease-in-out';
  if (phase === 'entering' && slideDirection) {
    transform = slideDirection === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    transition = 'none';
  }
  return <div style={{ transform, transition, width: '100%', height: '100%' }} onTransitionEnd={onTransitionEnd}>{children}</div>;
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button kind="quiet" icon={<Svg>{children}</Svg>} aria-label={label} title={label} disabled={disabled} onClick={onClick} />;
}

function FilterSwitch({ label, checked, onChange, note, testId }: { label: string; checked: boolean; onChange: () => void; note?: string; testId: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ctp-subtext1 cursor-pointer whitespace-nowrap" data-testid={testId}>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
      {label}
      {note && <span className="text-ctp-overlay1">{note}</span>}
    </label>
  );
}

const Sep = () => <span className="w-px h-4 bg-surface-0 mx-1 flex-shrink-0" />;

function Hint({ keys, text }: { keys: React.ReactNode[]; text: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="flex items-center gap-0.5">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
      <span>{text}</span>
    </span>
  );
}

export function MainPanel({ api }: { api: PluginAPI }) {
  const isAppMode = api.context.mode === 'app';
  const newChrome = useChromeFlagStore((s) => s.enabled);

  // Agent reactivity
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  // Saved filters
  const [includeSleeping, setIncludeSleeping] = useState(api.settings.get<boolean>('include-sleeping') ?? true);
  const [savedNeedsYouOnly, setSavedNeedsYouOnly] = useState(api.settings.get<boolean>('needs-attention-only') ?? false);
  const [includeRemote, setIncludeRemote] = useState(api.settings.get<boolean>('include-remote') ?? true);
  useEffect(() => {
    const sub = api.settings.onChange((key, value) => {
      if (key === 'include-sleeping') setIncludeSleeping(value as boolean);
      if (key === 'needs-attention-only') setSavedNeedsYouOnly(value as boolean);
      if (key === 'include-remote') setIncludeRemote(value as boolean);
    });
    return () => sub.dispose();
  }, [api]);

  // Needs you > Review applies Needs you only for this visit, leaving the saved setting alone.
  const launch = useChromeStore((s) => s.appLaunch);
  const freshLaunch = isAppMode && launch?.id === 'review' && launch.seq > appliedLaunchSeq ? launch : null;
  const [visitNeedsYou, setVisitNeedsYou] = useState<boolean | null>(() => (freshLaunch?.params.needsYouOnly ? true : null));
  const needsYouOnly = visitNeedsYou ?? savedNeedsYouOnly;

  // Navigation state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<SlideDirection>(null);

  useEffect(() => {
    if (!freshLaunch) return;
    const first = appliedLaunchSeq === 0;
    appliedLaunchSeq = freshLaunch.seq;
    setVisitNeedsYou(freshLaunch.params.needsYouOnly ? true : null);
    if (!first) { setSlideDirection(null); setCurrentIndex(0); }
  }, [freshLaunch]);

  const allAgents = useMemo(() => {
    const agents = api.agents.list();
    return isAppMode ? agents : agents.filter((a) => a.projectId === api.context.projectId);
  }, [api, isAppMode, agentTick]);

  const detailedStatuses = useMemo(() => {
    const map = new Map<string, PluginAgentDetailedStatus | null>();
    for (const a of allAgents) map.set(a.id, api.agents.getDetailedStatus(a.id));
    return map;
  }, [api, allAgents, agentTick]);

  const agents = useMemo(() => {
    let filtered = filterRemoteAgents(filterAgents(allAgents, includeSleeping), includeRemote);
    if (needsYouOnly) filtered = filterNeedsAttention(filtered, detailedStatuses);
    return filtered;
  }, [allAgents, includeSleeping, includeRemote, needsYouOnly, detailedStatuses]);

  useEffect(() => {
    setCurrentIndex((prev) => (agents.length === 0 ? 0 : Math.min(prev, agents.length - 1)));
  }, [agents.length]);

  const safeIndex = clampIndex(currentIndex, agents.length);
  const agent: AgentInfo | null = agents[safeIndex] ?? null;

  // Browsing vs typing to the agent. Typing belongs to one running agent: when the agent
  // changes (navigation, or Needs you only dropping it) or stops running, the view is
  // browsing again in the same render, so the next agent never mounts with the keyboard.
  // The ref is read in key and focus handlers, which run before a re-render.
  const rootRef = useRef<HTMLDivElement>(null);
  const [typingAgentId, setTypingAgentId] = useState<string | null>(null);
  const typing = !!agent && agent.status === 'running' && typingAgentId === agent.id;
  const typingRef = useRef(false);
  useLayoutEffect(() => { typingRef.current = typing; });
  const setTyping = useCallback((agentId: string | null) => { typingRef.current = agentId !== null; setTypingAgentId(agentId); }, []);
  const browse = useCallback(() => {
    setTyping(null);
    rootRef.current?.focus({ preventScroll: true });
  }, [setTyping]);
  // Typing ended because the agent changed or stopped: take the keys back, unless the user is elsewhere.
  useEffect(() => {
    if (typing || typingAgentId === null) return;
    setTypingAgentId(null);
    const active = document.activeElement;
    if (!active || active === document.body || rootRef.current?.contains(active)) rootRef.current?.focus({ preventScroll: true });
  }, [typing, typingAgentId]);

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  const goTo = useCallback((delta: -1 | 1) => {
    browse();
    if (agents.length <= 1) return;
    setSlideDirection(delta === 1 ? 'right' : 'left');
    setCurrentIndex((prev) => resolveIndex(clampIndex(prev, agents.length), agents.length, delta));
  }, [agents.length, browse]);
  const goPrev = useCallback(() => goTo(-1), [goTo]);
  const goNext = useCallback(() => goTo(1), [goTo]);

  const jumpTo = useCallback((index: number) => {
    if (index < 0 || index >= agents.length) return;
    browse();
    setSlideDirection(null);
    setCurrentIndex(index);
  }, [agents.length, browse]);

  // ⌘← / ⌘→ (manifest commands) work from anywhere, including while typing.
  useEffect(() => {
    reviewNav.prev = goPrev;
    reviewNav.next = goNext;
    return () => { reviewNav.prev = null; reviewNav.next = null; };
  }, [goPrev, goNext]);

  // The classic title bar shows "Review — name"; the new chrome keeps its breadcrumb and moves the sidebar selection instead.
  useEffect(() => {
    if (newChrome) {
      api.window.resetTitle();
      return;
    }
    if (agent) api.window.setTitle(`Review — ${agent.name}`);
    else api.window.resetTitle();
  }, [api, agent?.name, newChrome]);
  useEffect(() => {
    if (!newChrome || !isAppMode) return;
    useChromeStore.getState().setAppViewAgent(agent?.id ?? null);
  }, [newChrome, isAppMode, agent?.id]);
  useEffect(() => () => useChromeStore.getState().setAppViewAgent(null), []);

  // Filters
  const toggleSleeping = useCallback(() => {
    setIncludeSleeping(!includeSleeping);
    api.settings.set('include-sleeping', !includeSleeping);
  }, [includeSleeping, api]);
  const toggleRemote = useCallback(() => {
    setIncludeRemote(!includeRemote);
    api.settings.set('include-remote', !includeRemote);
  }, [includeRemote, api]);
  // Changing Needs you only by hand ends the visit's preset and saves the choice.
  const setNeedsYouOnly = useCallback((on: boolean) => {
    setVisitNeedsYou(null);
    setSavedNeedsYouOnly(on);
    api.settings.set('needs-attention-only', on);
  }, [api]);
  const clearFilters = useCallback(() => {
    setNeedsYouOnly(false);
    setIncludeSleeping(true);
    api.settings.set('include-sleeping', true);
    setIncludeRemote(true);
    api.settings.set('include-remote', true);
  }, [api, setNeedsYouOnly]);

  const contentRef = useRef<HTMLDivElement>(null);

  // Actions
  const sleepingRef = useRef<SleepingCardHandle>(null);
  const isSleeping = agent?.status === 'sleeping';
  const isRunning = agent?.status === 'running';
  // Only durable agents sleep and wake; a quick agent's kill ends it for good.
  const isDurable = agent?.kind === 'durable';
  const canSleep = isRunning && isDurable;
  const canWake = isSleeping && isDurable;
  const sleep = useCallback(() => { if (agent && canSleep) void api.agents.kill(agent.id); }, [agent, canSleep, api]);
  const wake = useCallback(() => { if (canWake) sleepingRef.current?.wake(); }, [canWake]);
  const typeToAgent = useCallback(() => {
    if (!agent) return;
    if (isSleeping) { sleepingRef.current?.focusPrompt(); return; }
    if (!isRunning) return;
    setTyping(agent.id);
    // Hand the agent the focus once its view has re-rendered with focused={true}:
    // the chat composer for an agent running in chat, xterm otherwise.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!typingRef.current) return;
      const composer = contentRef.current?.querySelector<HTMLTextAreaElement>(COMPOSER);
      if (composer) composer.focus();
      else window.dispatchEvent(new Event(FOCUS_ACTIVE_TERMINAL_EVENT));
    }));
  }, [agent, isSleeping, isRunning, setTyping]);

  // Jump list
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const [jumpAt, setJumpAt] = useState<{ x: number; y: number } | null>(null);
  const JUMP_WIDTH = 280;
  const openJumpList = useCallback(() => {
    const r = jumpButtonRef.current?.getBoundingClientRect();
    if (!r || agents.length === 0) return;
    setJumpAt({ x: r.right - JUMP_WIDTH, y: r.bottom + 4 });
  }, [agents.length]);
  const closeJumpList = useCallback(() => {
    setJumpAt(null);
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const jumpItems: MenuItem[] = useMemo(() => agents.map((a, i) => {
    const dot = reviewDot(a, detailedStatuses.get(a.id));
    const word = isRemoteAgentId(a.id) ? `${statusWord(dot)}, remote` : statusWord(dot);
    return {
      id: a.id,
      label: a.name,
      selected: i === safeIndex,
      shortcut: i < 9 ? String(i + 1) : undefined,
      leading: <span className="flex items-center gap-2"><StatusDot dot={dot} /><ReviewAvatar agentId={a.id} /></span>,
      trailing: word,
      onSelect: () => jumpTo(i),
    };
  }), [agents, detailedStatuses, safeIndex, jumpTo]);

  // Single keys while browsing. Keys typed into the agent, the wake prompt or the menu stay there.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    // In the jump list, 1–9 pick an agent directly (the menu bubbles its keys here through the portal).
    if (jumpAt && (e.target as HTMLElement).closest?.('[data-testid="review-jump-list"]')) {
      const action = browseAction(e);
      if (action?.type === 'jump') { e.preventDefault(); closeJumpList(); jumpTo(action.index); }
      return;
    }
    if (typingRef.current) return;
    if (ownsKeys(e.target as HTMLElement)) return;
    const action = browseAction(e);
    if (!action) return;
    // Space and Return on a toolbar button press it.
    if (action.type === 'type' && (e.target as HTMLElement).closest('button, label')) return;
    e.preventDefault();
    if (action.type === 'prev') goPrev();
    else if (action.type === 'next') goNext();
    else if (action.type === 'sleep') sleep();
    else if (action.type === 'wake') wake();
    else if (action.type === 'jump') jumpTo(action.index);
    else if (action.type === 'jump-list') openJumpList();
    else typeToAgent();
  };

  // The terminal focuses itself when it mounts. Unless the user clicked into it or pressed Return, keep browsing.
  const onContentPointerDown = (e: React.PointerEvent) => {
    if (agent && isRunning && (e.target as HTMLElement).closest('.xterm')) setTyping(agent.id);
  };
  // Moving focus out of the agent (a toolbar click, the sidebar) goes back to browsing.
  const onContentBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (typingRef.current && to && !contentRef.current?.contains(to)) setTyping(null);
  };
  const onContentFocus = (e: React.FocusEvent) => {
    if (typingRef.current) return;
    const target = e.target as HTMLElement;
    // The chat composer never focuses itself, so focus landing there is the user typing to the agent.
    if (target.closest(COMPOSER)) { if (agent && isRunning) setTyping(agent.id); return; }
    if (!target.closest('.xterm')) return;
    requestAnimationFrame(() => { if (!typingRef.current) rootRef.current?.focus({ preventScroll: true }); });
  };

  const projectName = useProjectName(isAppMode ? agent?.projectId : undefined);
  const newAgentProjectId = (isAppMode ? useProjectStore.getState().activeProjectId : api.context.projectId) ?? null;
  const onNewAgent = newChrome && newAgentProjectId && !isRemoteAgentId(newAgentProjectId)
    ? () => openNewAgentOrDialog('durable', newAgentProjectId)
    : undefined;

  const empty = !agent;
  const cause = empty ? emptyCause(allAgents, { includeSleeping, includeRemote, needsYouOnly }) : null;
  const dot = agent ? reviewDot(agent, detailedStatuses.get(agent.id)) : null;
  const navDisabled = agents.length <= 1;
  const isMac = window.clubhouse?.platform === 'darwin';
  const cmd = isMac ? '⌘' : 'Ctrl+';

  const toolbar = (
    <div className="h-8 flex-shrink-0 flex items-center gap-0.5 pl-1.5 pr-2.5 border-b border-surface-0 bg-ctp-base min-w-0" data-testid="review-toolbar">
      <NavButton label="Previous agent" disabled={navDisabled} onClick={goPrev}>{Icon.chevronLeft}</NavButton>
      <NavButton label="Next agent" disabled={navDisabled} onClick={goNext}>{Icon.chevronRight}</NavButton>
      <span className="ml-1 flex items-center gap-2 min-w-0 text-xs" data-testid="review-agent-info-slot">
        {agent && dot ? (
          <>
            <StatusDot dot={dot} />
            <ReviewAvatar agentId={agent.id} />
            <span className="font-medium text-ctp-text truncate">{agent.name}</span>
            <span className="text-ctp-text flex-shrink-0" data-testid="review-status-word">{statusWord(dot)}</span>
            <span className="text-ctp-overlay1 truncate">
              {[projectName, `${safeIndex + 1} of ${agents.length}`].filter(Boolean).join(' · ')}
            </span>
          </>
        ) : (
          <span className="text-ctp-overlay1">No agents to review</span>
        )}
      </span>
      <span className="ml-auto pl-3 flex items-center gap-3.5 flex-shrink-0">
        {agent && (isSleeping ? (
          canWake && (
            <Button kind="quiet" icon={<Svg>{Icon.bolt}</Svg>} onClick={wake} data-testid="review-wake-button">Wake</Button>
          )
        ) : canSleep && (
          <Button kind="quiet" icon={<Svg>{Icon.moon}</Svg>} onClick={sleep} data-testid="review-sleep-button">Sleep</Button>
        ))}
        {(canWake || canSleep) && <Sep />}
        <FilterSwitch
          label="Needs you only"
          checked={needsYouOnly}
          onChange={() => setNeedsYouOnly(!needsYouOnly)}
          note={visitNeedsYou !== null && visitNeedsYou !== savedNeedsYouOnly ? 'this visit' : undefined}
          testId="review-filter-needs-you"
        />
        <FilterSwitch label="Sleeping" checked={includeSleeping} onChange={toggleSleeping} testId="review-filter-sleeping" />
        <FilterSwitch label="Remote" checked={includeRemote} onChange={toggleRemote} testId="review-filter-remote" />
        <Sep />
        <Button
          ref={jumpButtonRef}
          kind="ghost"
          onClick={() => (jumpAt ? closeJumpList() : openJumpList())}
          disabled={empty}
          aria-haspopup="menu"
          aria-expanded={!!jumpAt}
          data-testid="review-jump-list-button"
          className={`pr-2 ${jumpAt ? 'bg-surface-0 text-ctp-text' : ''}`}
        >
          Jump to<span className="text-ctp-overlay1 flex"><Svg size={12}>{Icon.chevronDown}</Svg></span>
        </Button>
      </span>
    </div>
  );

  const hints = typing && agent ? (
    <>
      <span className="flex items-center gap-1.5">{dot && <StatusDot dot={dot} />}<span className="text-ctp-subtext1">Typing to {agent.name}</span></span>
      <span className="ml-auto"><Hint keys={[`${cmd}←`, `${cmd}→`]} text="move on and go back to browsing" /></span>
    </>
  ) : (
    <>
      <span className="flex items-center gap-1.5"><Hint keys={['←', '→']} text="or" /><Hint keys={['J', 'K']} text="move" /></span>
      {isSleeping ? <>{canWake && <Hint keys={['W']} text="wake" />}<Hint keys={['→']} text="skip" /></> : canSleep && <Hint keys={['S']} text="sleep" />}
      <Hint keys={['1', '–', '9']} text="jump" />
      <Hint keys={['G']} text="jump list" />
      {isRunning && <Hint keys={['↵']} text="type to the agent" />}
      <span className="ml-auto"><Hint keys={[`${cmd}←`, `${cmd}→`]} text="work from anywhere" /></span>
    </>
  );

  // AgentView shows the agent the way it runs: the chat transcript in chat, the terminal otherwise (#2089).
  const AgentView = api.widgets.AgentView ?? api.widgets.AgentTerminal;
  let content: React.ReactNode = null;
  if (agent) {
    content = (
      <SlideContainer agentId={agent.id} slideDirection={slideDirection} onTransitionEnd={() => setSlideDirection(null)}>
        {isSleeping ? (
          <SleepingCard ref={sleepingRef} api={api} agent={agent} onSkip={goNext} onLeavePrompt={browse} />
        ) : (
          <div className="h-full w-full"><AgentView agentId={agent.id} focused={typing} /></div>
        )}
      </SlideContainer>
    );
  } else if (cause) {
    content = (
      <ReviewEmptyState
        cause={cause}
        all={allAgents}
        detailed={detailedStatuses}
        onShowSleeping={toggleSleeping}
        onShowEveryone={() => setNeedsYouOnly(false)}
        onToggleSleeping={toggleSleeping}
        onToggleRemote={toggleRemote}
        onClearFilters={clearFilters}
        onWake={(id) => { wakeAgent(id, { resume: true }).catch((err: unknown) => reportChromeActionFailed('agent_start', err)); }}
        onNewAgent={onNewAgent}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative h-full w-full flex flex-col overflow-hidden bg-ctp-base focus:outline-none"
      data-testid="review-panel"
      data-mode={typing ? 'typing' : 'browsing'}
    >
      {toolbar}
      <div ref={contentRef} className="relative flex-1 min-h-0 overflow-hidden" onPointerDownCapture={onContentPointerDown} onFocusCapture={onContentFocus} onBlurCapture={onContentBlur}>
        {content}
      </div>
      {!empty && (
        <div className="h-7 flex-shrink-0 flex items-center gap-[18px] px-3 border-t border-surface-0 bg-ctp-base text-xs text-ctp-overlay1 overflow-hidden" data-testid="review-hints">
          {hints}
        </div>
      )}
      {jumpAt && (
        <PopupMenu items={jumpItems} position={jumpAt} minWidth={JUMP_WIDTH} label="Jump to an agent" testId="review-jump-list" onClose={closeJumpList} />
      )}
    </div>
  );
}
