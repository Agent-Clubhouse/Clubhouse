/**
 * What an agent's avatar draws, from its record alone. The desktop's
 * AgentAvatar renders this, and the Annex contract fixtures record it so a
 * phone can check that it draws the same (docs/mobile-control-v1.md).
 */

import { getAgentColorHex } from './name-generator';

/** The fields an avatar depends on. All of them are in an Annex snapshot's agent rows. */
export interface AvatarSubject {
  name: string;
  kind?: string;
  color?: string;
  emoji?: string | null;
  icon?: string | null;
}

export type AvatarSpec =
  | { type: 'quick' }
  | { type: 'emoji'; emoji: string; background: string }
  | { type: 'image'; image: string }
  | { type: 'initials'; initials: string; background: string };

/** The first letter of each `-` separated word, uppercased, at most two: `clever-fox` is CF, `Dispatcher` is D. */
export function agentInitials(name: string): string {
  const firsts = name.split('-').map((word) => Array.from(word)[0] ?? '');
  return Array.from(firsts.join('').toUpperCase()).slice(0, 2).join('');
}

/** A quick agent's bolt comes first, then the emoji, the image, and initials on the agent's color. */
export function agentAvatarSpec(agent: AvatarSubject, iconData?: string | null): AvatarSpec {
  if ((agent.kind ?? 'durable') !== 'durable') return { type: 'quick' };
  const color = getAgentColorHex(agent.color);
  // The hex pair is the color's alpha: 0x20, about 12.5%.
  if (agent.emoji) return { type: 'emoji', emoji: agent.emoji, background: `${color}20` };
  if (agent.icon && iconData) return { type: 'image', image: iconData };
  return { type: 'initials', initials: agentInitials(agent.name), background: color };
}
