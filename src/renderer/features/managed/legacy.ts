import type { DurableAgentConfig } from '../../../shared/types';

/**
 * Display names of the built-in personas an agent may still name (#2901).
 * Personas were retired, so this is only for the line that offers the switch;
 * any other id shows as it is.
 */
const LEGACY_PERSONA_NAMES: Readonly<Record<string, string>> = {
  'project-manager': 'Project Manager',
  'group-project-pm': 'Group Project PM',
  'qa': 'Quality Assurance',
  'ui-lead': 'UI/Design Lead',
  'quality-auditor': 'Quality Auditor',
  'executor-pr-only': 'Executor (PR Only)',
  'executor-merge': 'Executor (Full Merge)',
  'doc-updater': 'Documentation Updater',
  'judge': 'Judge',
  'researcher': 'Researcher',
  'orchestrator': 'Orchestrator',
  'workhorse': 'Workhorse',
};

/** A legacy persona id as people read it. */
export function legacyPersonaName(id: string): string {
  return LEGACY_PERSONA_NAMES[id] ?? id;
}

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
  const persona = config.persona ? legacyPersonaName(config.persona) : null;
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

/** The notice on an agent Clubhouse switched to managed on its own (D59). */
export function migratedLine(backup: string): string {
  return `Switched to managed when Clubhouse updated. Its earlier files are kept in ${backup}.`;
}

/** Why an automatic switch didn't happen, beside the switch offer (D59). */
export function migrationFailedLine(reason: string): string {
  return `Clubhouse couldn't switch it when it updated. ${reason}`;
}
