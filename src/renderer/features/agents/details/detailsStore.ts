import { create } from 'zustand';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

/**
 * Whether Agent details (#2032) is showing, for every agent pane in this
 * window. One toggle (⌥⌘D or the toolbar button) shows or hides the whole
 * column; there is no pane, width or per-agent state to remember.
 */

const KEY = 'clubhouse.agentDetails.open';
/** Settings is the only card persisted across visits, using its original key. */
const SETTINGS_KEY = 'clubhouse.agentDetails.settingsOpen';

export type CardId = 'settings' | 'changes' | 'dispatcher' | 'orchestrate' | 'subagents' | 'connections' | 'actions' | 'skills-mcp' | 'session' | 'canvases';
type FocusCard = CardId | 'helpers' | 'context' | 'mcp' | 'provider-skills';

export function containingDetailsCard(card: FocusCard): CardId {
  if (card === 'helpers') return 'orchestrate';
  if (card === 'context') return 'session';
  if (card === 'mcp' || card === 'provider-skills') return 'skills-mcp';
  return card;
}

/**
 * Cards start collapsed, apart from the saved Settings preference. Other
 * toggles last for this agent visit; pending approvals open Orchestration once.
 * The awake column and sleeping presentation share this policy.
 */
export function useDetailsCardState(agentId: string, waiting: boolean) {
  const [state, setState] = useState(() => ({ agentId, cards: new Set<CardId>() }));
  const openCards = state.agentId === agentId ? state.cards : new Set<CardId>();
  const setOpenCards = useCallback((update: SetStateAction<Set<CardId>>) => {
    setState((s) => {
      const current = s.agentId === agentId ? s.cards : new Set<CardId>();
      return { agentId, cards: typeof update === 'function' ? update(current) : update };
    });
  }, [agentId]);
  useEffect(() => { setOpenCards((s) => s); }, [setOpenCards]);
  const autoOpened = useRef(false);
  useEffect(() => { autoOpened.current = false; }, [agentId]);
  useEffect(() => {
    if (!waiting || autoOpened.current) return;
    autoOpened.current = true;
    setOpenCards((s) => new Set(s).add('orchestrate'));
  }, [waiting, setOpenCards]);
  const toggleCard = useCallback((id: CardId) => setOpenCards((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), [setOpenCards]);
  return { openCards, setOpenCards, toggleCard };
}

function readOpen(key = KEY): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // telemetry-exempt: storage unavailable; details start hidden.
    return false;
  }
}

function writeOpen(open: boolean, key = KEY): void {
  // Popouts have no details column; their ⌥⌘D mustn't change the main window's.
  if (typeof window !== 'undefined' && window.clubhouse?.window?.isPopout?.()) return;
  try {
    localStorage.setItem(key, open ? '1' : '0');
  } catch {
    // telemetry-exempt: storage unavailable; the toggle still works this session.
  }
}

/** A request to open one card from elsewhere, e.g. "Open in details" on a subagent card. */
export interface DetailsFocus {
  agentId: string;
  card: FocusCard;
  /** The subagent to expand, for the Subagents card. */
  subagentId?: string;
  nonce: number;
}

interface AgentDetailsState {
  open: boolean;
  /** The Settings card is open, for every agent; it starts collapsed. */
  settingsOpen: boolean;
  focus: DetailsFocus | null;
  /** Agents whose pane shows the Changes review instead of Chat or Terminal. */
  review: Record<string, boolean>;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Show the column and open one card in it. */
  reveal: (focus: Omit<DetailsFocus, 'nonce'>) => void;
  setReview: (agentId: string, on: boolean) => void;
}

export const useAgentDetailsStore = create<AgentDetailsState>((set, get) => ({
  open: readOpen(),
  settingsOpen: readOpen(SETTINGS_KEY),
  focus: null,
  review: {},
  setReview: (agentId, on) => set((s) => {
    if (!!s.review[agentId] === on) return s;
    const review = { ...s.review };
    if (on) review[agentId] = true; else delete review[agentId];
    return { review };
  }),
  toggle: () => get().setOpen(!get().open),
  setOpen: (open) => { writeOpen(open); set({ open }); },
  setSettingsOpen: (settingsOpen) => { writeOpen(settingsOpen, SETTINGS_KEY); set({ settingsOpen }); },
  reveal: (focus) => {
    writeOpen(true);
    set((s) => ({ open: true, focus: { ...focus, nonce: (s.focus?.nonce ?? 0) + 1 } }));
  },
}));
