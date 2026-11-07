import type { DurableAgentConfig } from '../../../shared/types';
import { getPersonaTemplate } from '../personas';

/**
 * What an unmanaged agent uses from the older ways of configuring agents
 * (#2901): Clubhouse Mode (on for its project and not turned off for it) and
 * a persona. Null for a managed agent or one that uses neither.
 */
export interface LegacyUse {
  clubhouseMode: boolean;
  /** The persona's display name. */
  persona: string | null;
}

type LegacyFields = Pick<DurableAgentConfig, 'managed' | 'clubhouseModeOverride' | 'persona'>;

export function legacyUse(config: LegacyFields, clubhouseModeOnForProject: boolean): LegacyUse | null {
  if (config.managed) return null;
  const clubhouseMode = clubhouseModeOnForProject && !config.clubhouseModeOverride;
  const persona = config.persona ? getPersonaTemplate(config.persona)?.name ?? config.persona : null;
  return clubhouseMode || persona ? { clubhouseMode, persona } : null;
}

/** "Ada uses Clubhouse Mode." or "Ada uses the Reviewer persona." */
export function legacyLine(name: string, use: LegacyUse): string {
  if (use.clubhouseMode && use.persona) return `${name} uses Clubhouse Mode and the ${use.persona} persona.`;
  if (use.clubhouseMode) return `${name} uses Clubhouse Mode.`;
  return `${name} uses the ${use.persona} persona.`;
}

/** What the bulk list shows for an agent: "Clubhouse Mode", the persona, both, or "Plain". */
export function legacyLabel(use: LegacyUse | null): string {
  if (!use) return 'Plain';
  if (use.clubhouseMode && use.persona) return `Clubhouse Mode, ${use.persona} persona`;
  if (use.clubhouseMode) return 'Clubhouse Mode';
  return `${use.persona} persona`;
}
