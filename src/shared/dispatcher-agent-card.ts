/**
 * An agent's card as its Dispatcher card in Details shows it (#3049, part of
 * #3034). The card itself lives at the top of the agent's page in the
 * Dispatcher's memory, `agents/<agent>.md` (#3041). The agent writes it when
 * asked; the user can replace it from Details.
 */

/** The card's three fields. Details shows "When to reach it" and "Owns", with "What it's for" as the one-line summary. */
export interface AgentCardFields {
  /** What it's for. */
  purpose: string;
  /** When to reach it. */
  contactWhen: string;
  /** What it owns: repositories, areas, decisions. */
  owns: string;
}

/**
 * - `ready`: it has a card.
 * - `asking`: Clubhouse asked the agent and it still has time to answer.
 * - `none`: no card, and no answer on the way.
 */
export type AgentCardState = 'ready' | 'asking' | 'none';

export interface AgentCardView {
  state: AgentCardState;
  card: Partial<AgentCardFields> | null;
  /**
   * A request is open but hasn't reached the agent yet: it goes when the agent
   * next runs. Only meaningful while `state` is `none`.
   */
  waitingToAsk?: boolean;
}

/** The most each field may hold, in characters: a sentence or two, not a document. */
export const AGENT_CARD_FIELD_MAX = 600;

/** The fields a user may edit from Details, cleaned up: one line each, cut to the limit. Unknown keys are dropped. */
export function cleanCardEdit(raw: unknown): Partial<AgentCardFields> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<AgentCardFields> = {};
  for (const key of ['purpose', 'contactWhen', 'owns'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = value.replace(/\s*\n\s*/g, ' ').trim().slice(0, AGENT_CARD_FIELD_MAX);
  }
  return out;
}
