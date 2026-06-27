import projectManager from './project-manager.md';
import groupProjectPm from './group-project-pm.md';
import qa from './qa.md';
import uiLead from './ui-lead.md';
import qualityAuditor from './quality-auditor.md';
import executorPrOnly from './executor-pr-only.md';
import executorMerge from './executor-merge.md';
import docUpdater from './doc-updater.md';
import judge from './judge.md';
import researcher from './researcher.md';
import { SkillDefinition } from '../../../../../shared/persona-pattern';

export interface PersonaTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  /** Tools relevant to this persona's role (consumed by provisioning — Mission 1d). */
  tools?: string[];
  /** Preferred agent orchestrator for this persona. */
  orchestrator?: 'claude' | 'copilot';
  /** Skills bundled with this persona (name + optional cadence). */
  skills?: SkillDefinition[];
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: 'project-manager',
    name: 'Project Manager',
    description: 'Delegator and planner. Dispatches work via the group project board. Does not write code.',
    content: projectManager,
    tools: ['read_bulletin', 'post_bulletin', 'read_topic', 'list_members', 'get_project_info'],
    orchestrator: 'claude',
    skills: [],
  },
  {
    id: 'group-project-pm',
    name: 'Group Project PM',
    description: 'Project manager who actively operates the group-project board: dispatches work, wakes/sleeps agents, manages polling, shoulder-taps, and keeps channels lean. Assumes privileged (admin) tools.',
    content: groupProjectPm,
    tools: ['read_bulletin', 'post_bulletin', 'read_topic', 'read_message', 'list_members', 'get_project_info', 'wake_agent', 'sleep_agent', 'start_polling', 'stop_polling', 'shoulder_tap', 'broadcast', 'clear_agent', 'compact_agent', 'clear_topic', 'delete_messages'],
    orchestrator: 'claude',
    skills: [{ name: 'group-pm-polling', cadence: '15m' }],
  },
  {
    id: 'qa',
    name: 'Quality Assurance',
    description: 'Skeptical reviewer and test coverage enforcer. Binary approve/reject decisions.',
    content: qa,
    tools: ['read_bulletin', 'post_bulletin', 'read_topic', 'test', 'lint', 'code-review'],
    orchestrator: 'claude',
    skills: [{ name: 'test' }, { name: 'validate-changes' }, { name: 'code-review' }],
  },
  {
    id: 'ui-lead',
    name: 'UI/Design Lead',
    description: 'Visual and interaction design. Creates specs, not code. Owns the design system.',
    content: uiLead,
    tools: ['read_bulletin', 'post_bulletin', 'read_topic'],
    orchestrator: 'claude',
    skills: [],
  },
  {
    id: 'quality-auditor',
    name: 'Quality Auditor',
    description: 'Reviews for AI-generated patterns: writing quality, code quality, UI quality.',
    content: qualityAuditor,
    tools: ['read_bulletin', 'post_bulletin', 'read_topic', 'code-review'],
    orchestrator: 'claude',
    skills: [{ name: 'code-review' }, { name: 'simplify' }],
  },
  {
    id: 'executor-pr-only',
    name: 'Executor (PR Only)',
    description: 'Implementation worker. Opens PRs but cannot merge.',
    content: executorPrOnly,
    tools: ['build', 'test', 'lint', 'create-pr', 'git'],
    orchestrator: 'claude',
    skills: [{ name: 'mission' }, { name: 'build' }, { name: 'test' }, { name: 'lint' }, { name: 'validate-changes' }, { name: 'create-pr' }],
  },
  {
    id: 'executor-merge',
    name: 'Executor (Full Merge)',
    description: 'Implementation worker with full merge permission.',
    content: executorMerge,
    tools: ['build', 'test', 'lint', 'create-pr', 'git', 'merge'],
    orchestrator: 'claude',
    skills: [{ name: 'mission' }, { name: 'build' }, { name: 'test' }, { name: 'lint' }, { name: 'validate-changes' }, { name: 'create-pr' }],
  },
  {
    id: 'doc-updater',
    name: 'Documentation Updater',
    description: 'Monitors git log and board, updates local markdown docs.',
    content: docUpdater,
    tools: ['read_bulletin', 'read_topic', 'git', 'edit'],
    orchestrator: 'claude',
    skills: [{ name: 'validate-changes' }],
  },
  {
    id: 'judge',
    name: 'Judge',
    description: 'Critical evaluation with scoring against criteria. Delivers clear yes/no verdicts.',
    content: judge,
    tools: ['read_bulletin', 'read_topic', 'code-review'],
    orchestrator: 'claude',
    skills: [{ name: 'code-review' }],
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Domain-scoped investigation with cited findings and actionable conclusions.',
    content: researcher,
    tools: ['read_bulletin', 'read_topic', 'web-search', 'web-fetch'],
    orchestrator: 'claude',
    skills: [{ name: 'deep-research' }],
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
