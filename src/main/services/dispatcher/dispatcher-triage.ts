/**
 * Which news reaches the Dispatcher's chat, and when (#3043). Pure rules: no
 * I/O, no clock of their own. dispatcher-news keeps the state and applies them.
 *
 * The Dispatcher decides what kind of news each report is (tell_user's
 * `kind`); these rules decide what the person sees:
 *
 * - Right away: news that needs the person, and an answer to a request they
 *   made. Which request a report is for, and what it does to that request,
 *   is dispatcher-requests' call (#3204): each is keyed to its id and the
 *   agents reached for it, so an unrelated report never answers it.
 * - Later: routine news waits for the next check-in summary, and so does an
 *   "answer" that is for no request.
 * - A check-in summary shows only when news is waiting for it, which is to
 *   say something changed since the last one.
 * - Never: a report with nothing left once tool noise is cleaned out, and
 *   news the person was already told.
 */

/** What the Dispatcher says a report is. */
export type NewsKind = 'needs_user' | 'answer' | 'routine' | 'check_in';

export const NEWS_KINDS: readonly NewsKind[] = ['needs_user', 'answer', 'routine', 'check_in'];

export function isNewsKind(value: unknown): value is NewsKind {
  return typeof value === 'string' && (NEWS_KINDS as readonly string[]).includes(value);
}

/** One report on its way to the chat, already cleaned of tool noise. */
export interface NewsItem {
  kind: NewsKind;
  text: string;
  /** The agent whose news it is. Absent for the Dispatcher's own words. */
  fromAgentId?: string;
  fromName?: string;
  at: number;
  /** The id of the request it answers or asks about (dispatcher-requests), when it is for one. */
  request?: string;
}

/** News waiting for the next check-in. */
export interface HeldNews {
  text: string;
  fromAgentId?: string;
  fromName?: string;
  at: number;
}

/** Something already shown, so the same news isn't shown twice. */
export interface ShownNews {
  text: string;
  fromAgentId?: string;
  at: number;
}

export interface TriageState {
  held: HeldNews[];
  shown: ShownNews[];
  lastCheckInAt?: number;
}

export type TriageDecision =
  | { show: 'now'; reason: 'needs_user' | 'answer' }
  /** A check-in summary, shown now, which takes the held news with it. */
  | { show: 'check_in'; held: HeldNews[] }
  | { show: 'later'; reason: 'routine' | 'nothing_asked' }
  | { show: 'never'; reason: 'empty' | 'duplicate' | 'nothing_changed' };

/** The same news from the same agent within this long is a repeat. */
export const DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** At most this much waits for a check-in; the oldest goes first. */
export const HELD_MAX = 30;
const SHOWN_MAX = 50;

export function emptyTriageState(): TriageState {
  return { held: [], shown: [] };
}

/** Text as compared for repeats: case, spacing and punctuation don't count. */
export function sameNewsKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
}

function isRepeat(item: NewsItem, state: TriageState, now: number): boolean {
  const key = sameNewsKey(item.text);
  const same = (n: { text: string; fromAgentId?: string }) => n.fromAgentId === item.fromAgentId && sameNewsKey(n.text) === key;
  return state.shown.some((n) => now - n.at < DUPLICATE_WINDOW_MS && same(n)) || state.held.some(same);
}

/** What happens to one report. */
export function triageNews(item: NewsItem, state: TriageState, now: number): TriageDecision {
  if (!item.text.trim()) return { show: 'never', reason: 'empty' };
  if (item.kind === 'check_in') {
    return state.held.length ? { show: 'check_in', held: state.held } : { show: 'never', reason: 'nothing_changed' };
  }
  if (isRepeat(item, state, now)) return { show: 'never', reason: 'duplicate' };
  switch (item.kind) {
    case 'needs_user':
      return { show: 'now', reason: 'needs_user' };
    case 'answer':
      return item.request ? { show: 'now', reason: 'answer' } : { show: 'later', reason: 'nothing_asked' };
    case 'routine':
      return { show: 'later', reason: 'routine' };
  }
}

function remember(shown: ShownNews[], item: NewsItem, now: number): ShownNews[] {
  return [...shown.filter((n) => now - n.at < DUPLICATE_WINDOW_MS), { text: item.text, fromAgentId: item.fromAgentId, at: item.at }].slice(-SHOWN_MAX);
}

/** The state after a decision. Old repeats are pruned on the way. */
export function applyTriage(state: TriageState, item: NewsItem, decision: TriageDecision, now: number): TriageState {
  switch (decision.show) {
    case 'now':
      return { ...state, shown: remember(state.shown, item, now) };
    case 'later': {
      const held: HeldNews = { text: item.text, at: item.at, ...(item.fromAgentId && { fromAgentId: item.fromAgentId }), ...(item.fromName && { fromName: item.fromName }) };
      return { ...state, held: [...state.held, held].slice(-HELD_MAX) };
    }
    case 'check_in':
      return { ...state, held: [], shown: remember(state.shown, item, now), lastCheckInAt: now };
    case 'never':
      return state;
  }
}

/**
 * Undo a decision to show news whose message never reached the chat (#3193):
 * forget it was shown, so it can be sent again, and hold again what a
 * check-in took. The request it settled is put back by dispatcher-requests.
 */
export function revertShown(state: TriageState, item: NewsItem, decision: TriageDecision): TriageState {
  if (decision.show !== 'now' && decision.show !== 'check_in') return state;
  const shown = state.shown.filter((n) => !(n.at === item.at && n.text === item.text && n.fromAgentId === item.fromAgentId));
  const held = decision.show === 'check_in' ? [...decision.held, ...state.held].slice(-HELD_MAX) : state.held;
  return { ...state, shown, held };
}
