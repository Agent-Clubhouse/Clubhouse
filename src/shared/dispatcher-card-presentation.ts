/** Shared read-only wording for the corresponding local and host Details cards. */
import type { AgentCardView } from './dispatcher-agent-card';
import { DEFAULT_DISPATCHER_NAME, type DispatcherState } from './dispatcher-types';

/** The Dispatcher's name as the user set it, or its working name. */
export function dispatcherName(state: Pick<DispatcherState, 'config'> | null | undefined): string {
  return state?.config?.name?.trim() || DEFAULT_DISPATCHER_NAME;
}

/**
 * The header's line once connected (#3249): the Dispatcher's name, never the
 * agent's own card text. The role word comes from the one shared name.
 */
export function connectedSummary(name: string): string {
  return name.toLowerCase() === DEFAULT_DISPATCHER_NAME.toLowerCase() ? 'connected' : `${name}, your ${DEFAULT_DISPATCHER_NAME.toLowerCase()}`;
}

export const ASKING_TEXT = 'Asking what it does…';
export const NO_DESCRIPTION_TEXT = 'No description yet';

export type DispatcherCardStatus = 'off' | 'asking' | 'ready' | 'none';

/** Which state the card is in, from the switch and the agent's card. */
export function cardStatus(on: boolean, view: AgentCardView | null, turningOn: boolean): DispatcherCardStatus {
  if (!on) return 'off';
  if (view?.state === 'ready') return 'ready';
  if (view?.state === 'asking' || turningOn) return 'asking';
  return 'none';
}

/** The header's one line for each state. */
export function cardSummary(status: DispatcherCardStatus, name: string): string {
  switch (status) {
    case 'off': return 'not connected';
    case 'asking': return ASKING_TEXT;
    case 'none': return NO_DESCRIPTION_TEXT;
    case 'ready': return connectedSummary(name);
  }
}

