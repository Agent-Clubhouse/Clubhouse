/**
 * Built-in agent parts and templates (#2902). Clubhouse owns these: they are
 * read-only to people and agents, and a new app version can ship new text.
 * Agents that use a built-in by reference pick up a new revision when their
 * next session starts.
 *
 * The role blocks start from today's persona files with their front matter
 * removed. The maintainer will rewrite them (#2902); the ids stay stable.
 */
import { getPersonaTemplate } from '../../../renderer/features/personas';
import { stripPersonaFrontMatter } from '../../../shared/persona-pattern';
import { CLUBHOUSE_MCP_PART_ID, type ManagedTemplate } from '../../../shared/managed-agents-types';
import type { BlockAssetPayload, McpAssetPayload } from '../../../shared/asset-catalog-types';

export interface BuiltinPart {
  id: string;
  kind: 'block' | 'mcp';
  name: string;
  description: string;
  payload: BlockAssetPayload | McpAssetPayload;
}

const IDENTITY = [
  'You are @@AgentName, an agent working in Clubhouse.',
  'Your workspace is @@Path and your branch is @@StandbyBranch.',
].join('\n');

const CLUBHOUSE_BASICS = [
  '# Working in Clubhouse',
  '',
  '- Work only inside your own workspace and branch. Other agents have their own; never edit their files or branches.',
  '- Before you say work is done, run @@BuildCommand, @@TestCommand and @@LintCommand, and report what passed and what did not.',
  '- If Clubhouse tools are available to you (they start with the Clubhouse MCP server), use them to message the agent that started you, to report progress, and to ask the person when you are blocked.',
  '- When something needs the person to decide, say so plainly and wait. Don\'t guess at choices that are theirs.',
].join('\n');

function persona(id: string): string {
  const template = getPersonaTemplate(id);
  if (!template) throw new Error(`built-in persona ${id} is missing`);
  return stripPersonaFrontMatter(template.content).trim();
}

/** Ids are stable forever: agents and templates point at them. */
export const BUILTIN_BLOCK_IDS = {
  identity: 'builtin-block-identity',
  basics: 'builtin-block-clubhouse-basics',
  orchestrator: 'builtin-block-orchestrator',
  projectManager: 'builtin-block-project-manager',
  groupLead: 'builtin-block-group-project-lead',
  qa: 'builtin-block-quality-assurance',
  developerMerge: 'builtin-block-developer-full-merge',
  developerPr: 'builtin-block-developer-no-merge',
  researcher: 'builtin-block-researcher',
  reviewer: 'builtin-block-code-reviewer',
  helper: 'builtin-block-helper',
} as const;

export function builtinParts(): BuiltinPart[] {
  const block = (id: string, name: string, description: string, content: string): BuiltinPart => ({ id, kind: 'block', name, description, payload: { content } });
  return [
    block(BUILTIN_BLOCK_IDS.identity, 'Identity', 'Tells the agent its name, workspace and branch.', IDENTITY),
    block(BUILTIN_BLOCK_IDS.basics, 'Clubhouse basics', 'How to work inside Clubhouse.', CLUBHOUSE_BASICS),
    block(BUILTIN_BLOCK_IDS.orchestrator, 'Orchestrator', 'Plans work and runs helpers to do it.', persona('orchestrator')),
    block(BUILTIN_BLOCK_IDS.projectManager, 'Project manager', 'Plans and dispatches work. Does not write code.', persona('project-manager')),
    block(BUILTIN_BLOCK_IDS.groupLead, 'Group project lead', 'Runs a group project board and the agents on it.', persona('group-project-pm')),
    block(BUILTIN_BLOCK_IDS.qa, 'Quality assurance', 'Reviews changes and test coverage. Approves or rejects.', persona('qa')),
    block(BUILTIN_BLOCK_IDS.developerMerge, 'Developer, full merge', 'Builds features and merges when checks pass.', persona('executor-merge')),
    block(BUILTIN_BLOCK_IDS.developerPr, 'Developer, no merge', 'Builds features and opens a PR for review.', persona('executor-pr-only')),
    block(BUILTIN_BLOCK_IDS.researcher, 'Researcher', 'Investigates and reports. Does not change code.', persona('researcher')),
    block(BUILTIN_BLOCK_IDS.reviewer, 'Code reviewer', 'Adversarial review of changes.', persona('judge')),
    block(BUILTIN_BLOCK_IDS.helper, 'Helper', 'Does one task for the agent that started it, then reports back.', persona('workhorse')),
    {
      id: CLUBHOUSE_MCP_PART_ID,
      kind: 'mcp',
      name: 'Clubhouse',
      description: 'Helpers, messages and the Dispatcher. Without it the agent can\'t orchestrate.',
      // Never delivered as written: the live bridge is injected per spawn with its own port and nonce.
      payload: { serverKey: 'clubhouse', transport: 'stdio', command: 'clubhouse-mcp-bridge' },
    },
  ];
}

const B = BUILTIN_BLOCK_IDS;
const base = (role: string[]) => [B.identity, B.basics, ...role];

/** Built-in templates. Not catalog assets: they hold references only, so they live in code. */
export function builtinTemplates(): ManagedTemplate[] {
  const t = (id: string, name: string, description: string, blocks: string[], settings: ManagedTemplate['settings'] = {}): ManagedTemplate => ({
    id, name, description, builtin: true,
    setup: { blocks, skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] },
    settings,
  });
  return [
    t('builtin-template-orchestrator', 'Orchestrator', 'Plans work and runs helpers to do it.', base([B.orchestrator]),
      { freeAgentMode: false, orchestration: { orchestrate: true, maxHelpers: 5, autoHelpers: true, connectToDispatcher: true } }),
    t('builtin-template-group-project-lead', 'Group Project Lead', 'Coordinates other agents through a group project.', base([B.groupLead]),
      { orchestration: { orchestrate: true, maxHelpers: 3, autoHelpers: true, connectToDispatcher: true } }),
    t('builtin-template-quality-assurance', 'Quality Assurance', 'Reviews changes and runs tests. Never merges.', base([B.qa])),
    t('builtin-template-developer-full-merge', 'Developer (Full Merge)', 'Builds features and merges when checks pass.', base([B.developerMerge])),
    t('builtin-template-developer-no-merge', 'Developer (No Merge)', 'Builds features and opens a PR for review.', base([B.developerPr])),
    t('builtin-template-project-manager', 'Project Manager', 'Plans and dispatches work. Does not write code.', base([B.projectManager]),
      { orchestration: { orchestrate: true, autoHelpers: true } }),
    t('builtin-template-researcher', 'Researcher', 'Investigates and reports. Does not change code.', base([B.researcher])),
    t('builtin-template-helper', 'Helper', 'The default for helpers: one task, then report back.', base([B.helper])),
  ];
}

export const DEFAULT_HELPER_TEMPLATE_ID = 'builtin-template-helper';
