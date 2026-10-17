import { create } from 'zustand';

/**
 * Whether Agent details (#2032) is showing, for every agent pane in this
 * window. One toggle (⌥⌘D or the toolbar button) shows or hides the whole
 * column; there is no pane, width or per-agent state to remember.
 */

const KEY = 'clubhouse.agentDetails.open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // telemetry-exempt: storage unavailable; details start hidden.
    return false;
  }
}

function writeOpen(open: boolean): void {
  // Popouts have no details column; their ⌥⌘D mustn't change the main window's.
  if (typeof window !== 'undefined' && window.clubhouse?.window?.isPopout?.()) return;
  try {
    localStorage.setItem(KEY, open ? '1' : '0');
  } catch {
    // telemetry-exempt: storage unavailable; the toggle still works this session.
  }
}

/** A request to open one card from elsewhere, e.g. "Open in details" on a subagent card. */
export interface DetailsFocus {
  agentId: string;
  card: 'changes' | 'subagents';
  /** The subagent to expand, for the Subagents card. */
  subagentId?: string;
  nonce: number;
}

interface AgentDetailsState {
  open: boolean;
  focus: DetailsFocus | null;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  /** Show the column and open one card in it. */
  reveal: (focus: Omit<DetailsFocus, 'nonce'>) => void;
}

export const useAgentDetailsStore = create<AgentDetailsState>((set, get) => ({
  open: readOpen(),
  focus: null,
  toggle: () => get().setOpen(!get().open),
  setOpen: (open) => { writeOpen(open); set({ open }); },
  reveal: (focus) => {
    writeOpen(true);
    set((s) => ({ open: true, focus: { ...focus, nonce: (s.focus?.nonce ?? 0) + 1 } }));
  },
}));
