import projectManager from './project-manager.md';
import qa from './qa.md';
import uiLead from './ui-lead.md';
import qualityAuditor from './quality-auditor.md';
import executorPrOnly from './executor-pr-only.md';
import executorMerge from './executor-merge.md';
import docUpdater from './doc-updater.md';
import judge from './judge.md';
import researcher from './researcher.md';
import orchestrator from './orchestrator.md';
import workhorse from './workhorse.md';

export interface PersonaTemplate {
  id: string;
  name: string;
  /** One sentence (about 80 characters) on what the persona does. Shown with the persona pickers. */
  description: string;
  content: string;
}

/** The built-in personas offered in the pickers. Ids are stored on agents, so they never change. */
export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: 'project-manager',
    name: 'Project Manager',
    description: 'Plans missions and hands them out to other agents, without writing code.',
    content: projectManager,
  },
  {
    id: 'qa',
    name: 'PR Reviewer',
    description: 'Reviews pull requests and ends with a clear approve or request changes.',
    content: qa,
  },
  {
    id: 'ui-lead',
    name: 'Design Lead',
    description: 'Reviews the rendered UI and writes design specs for developers to build.',
    content: uiLead,
  },
  {
    id: 'quality-auditor',
    name: 'AI Slop Detector',
    description: 'Flags padded or generic code, copy and UI, and proposes the fix.',
    content: qualityAuditor,
  },
  {
    id: 'executor-pr-only',
    name: 'Developer',
    description: 'Implements a task on its own branch and opens a PR for someone to merge.',
    content: executorPrOnly,
  },
  {
    id: 'executor-merge',
    name: 'Developer (merges)',
    description: 'Implements a task, opens a PR and merges it once checks and approvals pass.',
    content: executorMerge,
  },
  {
    id: 'doc-updater',
    name: 'Docs Writer',
    description: 'Keeps documentation true to the code after changes land, editing docs only.',
    content: docUpdater,
  },
  {
    id: 'judge',
    name: 'Solution Judge',
    description: 'Compares competing solutions against fixed criteria and picks one.',
    content: judge,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Answers a question with sourced findings and says what is still unknown.',
    content: researcher,
  },
  {
    // The front-matter carries the default orchestration policy (#2228). It
    // isn't a pattern setting, so applying the persona copies nothing onto
    // the agent; the policy reads it when it resolves.
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Splits an epic into tasks for helper agents, then checks and accepts the work.',
    content: orchestrator,
  },
  {
    id: 'workhorse',
    name: 'Generalist',
    description: 'A general helper that does the one task it is given and reports back.',
    content: workhorse,
  },
];

/**
 * Retired persona ids that existing agents may still store, mapped to the
 * listed persona that replaced them. They resolve but stay out of the pickers.
 */
const PERSONA_ALIASES: Record<string, string> = {
  // Merged into Project Manager; admin tools now depend on the project's admin role.
  'group-project-pm': 'project-manager',
};

const PERSONA_MAP = new Map(PERSONA_TEMPLATES.map((p) => [p.id, p]));

/** The listed persona id an id resolves to: itself, or its replacement for a retired id. */
export function canonicalPersonaId(id: string): string {
  return PERSONA_ALIASES[id] ?? id;
}

/**
 * Look up a persona template by ID, following retired ids to their
 * replacement. Returns undefined if not found.
 */
export function getPersonaTemplate(id: string): PersonaTemplate | undefined {
  return PERSONA_MAP.get(canonicalPersonaId(id));
}

/**
 * Get all listed persona IDs (retired aliases excluded).
 */
export function getPersonaIds(): string[] {
  return PERSONA_TEMPLATES.map((p) => p.id);
}

/** The one-line description shown under a persona picker, or undefined for none or an unknown id. */
export function personaDescription(id: string | undefined): string | undefined {
  return id ? getPersonaTemplate(id)?.description : undefined;
}
