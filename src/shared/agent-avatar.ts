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

/** sRGB relative luminance of a `#rrggbb` color, as WCAG 2 defines it. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The text color for initials on a solid `#rrggbb` background: white or black,
 * whichever has the higher WCAG contrast ratio, white on a tie. One of the two
 * always reaches at least 4.58:1. docs/mobile-control-v1.md has this formula.
 */
export function initialsTextColor(background: string): '#ffffff' | '#000000' {
  const luminance = relativeLuminance(background);
  const onWhite = 1.05 / (luminance + 0.05);
  const onBlack = (luminance + 0.05) / 0.05;
  return onWhite >= onBlack ? '#ffffff' : '#000000';
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
