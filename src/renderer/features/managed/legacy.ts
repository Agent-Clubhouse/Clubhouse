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
 * What an unmanaged agent still names from the older ways of configuring
 * agents (#2901): a persona. Clubhouse Mode was retired in step 4 and its
 * setting isn't read by the app any more, so it isn't shown. Null for a
 * managed agent or one with no persona.
 */
export interface LegacyUse {
  /** The persona's display name. */
  persona: string;
}

type LegacyFields = Pick<DurableAgentConfig, 'managed' | 'persona'>;

export function legacyUse(config: LegacyFields): LegacyUse | null {
  if (config.managed || !config.persona) return null;
  return { persona: legacyPersonaName(config.persona) };
}

/** "Ada uses the Reviewer persona." */
export function legacyLine(name: string, use: LegacyUse): string {
  return `${name} uses the ${use.persona} persona.`;
}

/** What the bulk list shows for an agent: the persona, or "Plain". */
export function legacyLabel(use: LegacyUse | null): string {
  return use ? `${use.persona} persona` : 'Plain';
}

/** The notice on an agent Clubhouse switched to managed on its own (D59). */
export function migratedLine(backup: string): string {
  return `Switched to managed when Clubhouse updated. Its earlier files are kept in ${backup}.`;
}

/** Why an automatic switch didn't happen, beside the switch offer (D59). */
export function migrationFailedLine(reason: string): string {
  return `Clubhouse couldn't switch it when it updated. ${reason}`;
}
