/**
 * Which news reaches the Dispatcher's chat, and when (#3043). Pure rules: no
 * I/O, no clock of their own. dispatcher-news keeps the state and applies them.
 *
 * The Dispatcher decides what kind of news each report is (tell_user's
 * `kind`); these rules decide what the person sees:
 *
 * - Right away: news that needs the person, and an answer to something they
 *   asked while that request is still open.
 * - Each request the person makes is answered once: by an answer, or by the
 *   Dispatcher's own reply that needs them, such as a question back (#3193).
 *   An agent's question doesn't answer it. Otherwise a reply that wasn't
 *   called an answer left the request open, and an agent's later progress,
 *   called an answer, showed as if the person had asked for it.
 * - Later: routine news waits for the next check-in summary, and so does an
 *   "answer" when nothing was asked.
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
  /** When each request the person handed off was made, oldest first, until it is answered. */
  openRequests: number[];
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

/** A request nobody answered in a week is no longer one an answer can be for. */
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The same news from the same agent within this long is a repeat. */
export const DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** At most this much waits for a check-in; the oldest goes first. */
export const HELD_MAX = 30;
const SHOWN_MAX = 50;

export function emptyTriageState(): TriageState {
  return { openRequests: [], held: [], shown: [] };
}

/** Text as compared for repeats: case, spacing and punctuation don't count. */
export function sameNewsKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
}

function openRequests(state: TriageState, now: number): number[] {
  return state.openRequests.filter((at) => now - at < REQUEST_TTL_MS);
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
      return openRequests(state, now).length ? { show: 'now', reason: 'answer' } : { show: 'later', reason: 'nothing_asked' };
    case 'routine':
      return { show: 'later', reason: 'routine' };
  }
}

function remember(shown: ShownNews[], item: NewsItem, now: number): ShownNews[] {
  return [...shown.filter((n) => now - n.at < DUPLICATE_WINDOW_MS), { text: item.text, fromAgentId: item.fromAgentId, at: item.at }].slice(-SHOWN_MAX);
}

/** The state after a decision. Expired requests and old repeats are pruned on the way. */
export function applyTriage(state: TriageState, item: NewsItem, decision: TriageDecision, now: number): TriageState {
  const requests = openRequests(state, now);
  switch (decision.show) {
    case 'now':
      return {
        ...state,
        // An answer, or the Dispatcher's own reply that needs the person, closes the oldest open request.
        openRequests: decision.reason === 'answer' || !item.fromAgentId ? requests.slice(1) : requests,
        shown: remember(state.shown, item, now),
      };
    case 'later': {
      const held: HeldNews = { text: item.text, at: item.at, ...(item.fromAgentId && { fromAgentId: item.fromAgentId }), ...(item.fromName && { fromName: item.fromName }) };
      return { ...state, openRequests: requests, held: [...state.held, held].slice(-HELD_MAX) };
    }
    case 'check_in':
      return { ...state, openRequests: requests, held: [], shown: remember(state.shown, item, now), lastCheckInAt: now };
    case 'never':
      return { ...state, openRequests: requests };
  }
}

/** The person handed something off: an answer to it shows right away. */
export function noteRequest(state: TriageState, now: number): TriageState {
  return { ...state, openRequests: [...openRequests(state, now), now] };
}
