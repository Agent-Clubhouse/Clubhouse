import projectManager from './project-manager.md';
import qa from './qa.md';
import uiLead from './ui-lead.md';
import qualityAuditor from './quality-auditor.md';
import executorPrOnly from './executor-pr-only.md';
import executorMerge from './executor-merge.md';
import docUpdater from './doc-updater.md';

export interface PersonaTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: 'project-manager',
    name: 'Project Manager',
    description: 'Delegator and planner. Dispatches work via the group project board. Does not write code.',
    content: projectManager,
  },
  {
    id: 'qa',
    name: 'Quality Assurance',
    description: 'Skeptical reviewer and test coverage enforcer. Binary approve/reject decisions.',
    content: qa,
  },
  {
    id: 'ui-lead',
    name: 'UI/Design Lead',
    description: 'Visual and interaction design. Creates specs, not code. Owns the design system.',
    content: uiLead,
  },
  {
    id: 'quality-auditor',
    name: 'Quality Auditor',
    description: 'Reviews for AI-generated patterns: writing quality, code quality, UI quality.',
    content: qualityAuditor,
  },
  {
    id: 'executor-pr-only',
    name: 'Executor (PR Only)',
    description: 'Implementation worker. Opens PRs but cannot merge.',
    content: executorPrOnly,
  },
  {
    id: 'executor-merge',
    name: 'Executor (Full Merge)',
    description: 'Implementation worker with full merge permission.',
    content: executorMerge,
  },
  {
    id: 'doc-updater',
    name: 'Documentation Updater',
    description: 'Monitors git log and board, updates local markdown docs.',
    content: docUpdater,
  },
];

const PERSONA_MAP = new Map(PERSONA_TEMPLATES.map((p) => [p.id, p]));

/**
 * Look up a persona template by ID. Returns undefined if not found.
 */
export function getPersonaTemplate(id: string): PersonaTemplate | undefined {
  return PERSONA_MAP.get(id);
}

/**
 * Get all valid persona IDs.
 */
export function getPersonaIds(): string[] {
  return PERSONA_TEMPLATES.map((p) => p.id);
}
