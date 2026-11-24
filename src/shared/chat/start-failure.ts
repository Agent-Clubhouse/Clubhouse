/**
 * Providers whose failed chat start never opens the terminal by itself
 * (#3785). The agent shows why, keeps what was typed in its composer, and
 * offers Retry and Open in terminal; the person picks. A terminal agent has
 * other approval and lifecycle rules, so the switch is theirs to make, and
 * nothing is replayed.
 */

import { ANTIGRAVITY_PROVIDER_ID } from '../providers/antigravity';

export function chatFailsExplicitly(providerId: string | undefined): boolean {
  return providerId === ANTIGRAVITY_PROVIDER_ID;
}

/** The runtime notice code for such a failure, when nothing reached the agent: its first message is still unsent. */
export const CHAT_START_FAILED_NOTICE = 'chat_start_failed';

/** The same, when the session had started, so the first message may have reached the agent. */
export const CHAT_START_FAILED_AFTER_START_NOTICE = 'chat_start_failed_after_start';
