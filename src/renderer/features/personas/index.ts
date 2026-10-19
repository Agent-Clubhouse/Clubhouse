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
  /** One line on what the persona does and when to pick it. Shown under the persona pickers. */
  description: string;
  content: string;
}

/** The built-in personas offered in the pickers. Ids are stored on agents, so they never change. */
export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: 'project-manager',
    name: 'Project Manager',
    description: 'Plans the work and hands it out as missions without writing code. Pick it to coordinate several agents, often on a group project board.',
    content: projectManager,
  },
  {
    id: 'qa',
    name: 'PR Reviewer',
    description: 'Reviews pull requests, confirms each finding and ends with approve or request changes. Pick it as the independent check before a merge.',
    content: qa,
  },
  {
    id: 'ui-lead',
    name: 'Design Lead',
    description: 'Reviews the rendered UI and writes design specs rather than production code. Pick it to keep new screens consistent with the app.',
    content: uiLead,
  },
  {
    id: 'quality-auditor',
    name: 'AI Slop Detector',
    description: 'Flags padded, generic or hollow code, copy and UI, and proposes the fix. Pick it for a cleanup pass on a diff or a page.',
    content: qualityAuditor,
  },
  {
    id: 'executor-pr-only',
    name: 'Developer, opens PRs',
    description: 'Implements a task on its own branch, runs the checks and opens a PR for someone else to merge. Pick it when another agent or person reviews and merges.',
    content: executorPrOnly,
  },
  {
    id: 'executor-merge',
    name: 'Developer, can merge',
    description: 'Implements a task, opens a PR and merges it once checks and approvals pass. Pick it when the agent should see its own work through to main.',
    content: executorMerge,
  },
  {
    id: 'doc-updater',
    name: 'Docs Writer',
    description: 'Keeps documentation true to the code and changes only docs. Pick it to update guides and references after changes land.',
    content: docUpdater,
  },
  {
    id: 'judge',
    name: 'Solution Judge',
    description: 'Compares competing solutions against fixed criteria and picks one, with evidence. Pick it to settle a bake-off or a choice between proposals.',
    content: judge,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Answers a question with sourced findings and says what is still unknown. Pick it when you need facts before deciding or building.',
    content: researcher,
  },
  {
    // The front-matter carries the default orchestration policy (#2228). It
    // isn't a pattern setting, so applying the persona copies nothing onto
    // the agent; the policy reads it when it resolves.
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Splits an epic into tasks, starts helper agents to do them, then checks and accepts their work. Pick it for work big enough to run in parallel.',
    content: orchestrator,
  },
  {
    id: 'workhorse',
    name: 'Workhorse',
    description: 'Does the one task it is given, pushes the work and reports back. Pick it for helpers an orchestrator starts, or when no other role fits.',
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
