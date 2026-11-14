/**
 * Built-in agent parts and templates (#2902). Clubhouse owns these: they are
 * read-only to people and agents, and a new app version can ship new text.
 * Agents that use a built-in by reference pick up a new revision when their
 * next session starts.
 *
 * The blocks and templates are data in `builtin-text/`: `manifest.json` holds
 * names, descriptions, template blocks and settings, and each block's text is
 * a Markdown file there. `scripts/sync-builtin-text.mjs` writes all of it from
 * an export of the maintainer's builder, so don't edit those files by hand.
 *
 * Built-ins the maintainer cut are retired (D71): they stay in the manifest
 * but are never installed. At startup, every agent and template that uses one
 * switches to a custom copy with the same name and text, and the built-in is
 * removed (D99, `adoptRetiredBuiltins` in service.ts).
 *
 * Built-in skills (build, test, lint, validate and the post-result skills)
 * come from the builder too: each is `builtin-text/skills/<name>/SKILL.md`,
 * delivered into the CLI's skills folder like any skill part. Like built-in
 * blocks they are read-only: people fork them in the library to make their own.
 */
import manifestJson from './builtin-text/manifest.json';
import { BUILTIN_SKILL_TEXT, BUILTIN_TEXT } from './builtin-text/index';
import { PREPARE_HANDOFF_SKILL_MD, PREPARE_HANDOFF_SKILL_NAME } from './app-skills/prepare-handoff';
import { CLUBHOUSE_MCP_PART_ID, PREPARE_HANDOFF_SKILL_ID, IDENTITY_BLOCK_ID, WORKING_IDENTITY_BLOCK_ID, workingIdentityBlocks, type ManagedTemplate, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import type { BlockAssetPayload, McpAssetPayload, SkillAssetPayload } from '../../../shared/asset-catalog-types';

export interface BuiltinPart {
  id: string;
  kind: 'block' | 'skill' | 'mcp';
  name: string;
  description: string;
  /** Cut by the maintainer: never installed; what used it gets a custom copy (D99). */
  retired?: true;
  payload: BlockAssetPayload | SkillAssetPayload | McpAssetPayload;
}

/** The shape of `builtin-text/manifest.json`. */
export interface BuiltinManifest {
  blocks: Array<{ id: string; name: string; description: string; file: string; retired?: boolean }>;
  /**
   * `name` is the library name and `skillName` the folder the CLI gets (its
   * SKILL.md front matter `name`). Variants can share a folder, so `file` is
   * by id: `skills/<id without builtin-skill->/SKILL.md`.
   */
  skills: Array<{ id: string; name: string; skillName: string; description: string; file: string; retired?: boolean }>;
  templates: Array<{ id: string; name: string; description: string; blocks: string[]; skills?: string[]; settings: ManagedTemplateSettings; retired?: boolean }>;
}

export const BUILTIN_MANIFEST = manifestJson as BuiltinManifest;

/**
 * Ids code refers to. Ids are stable forever: agents and templates point at
 * them. The manifest is the full list; a test checks each of these is in it.
 */
export const BUILTIN_BLOCK_IDS = {
  identity: IDENTITY_BLOCK_ID,
  identityHelper: WORKING_IDENTITY_BLOCK_ID,
  basics: 'builtin-block-clubhouse-basics',
  orchestrator: 'builtin-block-orchestrator',
  productOwner: 'builtin-block-product-owner',
  groupLead: 'builtin-block-group-project-lead',
  groupProjects: 'builtin-block-group-projects',
  qa: 'builtin-block-quality-assurance',
  developer: 'builtin-block-developer',
  pullRequests: 'builtin-block-pull-requests',
  merging: 'builtin-block-merging',
  researcher: 'builtin-block-researcher',
  helper: 'builtin-block-helper',
  // Retired (D71).
  projectManager: 'builtin-block-project-manager',
  developerMerge: 'builtin-block-developer-full-merge',
  developerPr: 'builtin-block-developer-no-merge',
  reviewer: 'builtin-block-code-reviewer',
} as const;

/** Built-in skill ids code refers to. The manifest is the full list; a test checks each is in it. */
export const BUILTIN_SKILL_IDS = {
  build: 'builtin-skill-build',
  test: 'builtin-skill-test',
  lint: 'builtin-skill-lint',
  validate: 'builtin-skill-validate',
  postResult: 'builtin-skill-post-result',
  postResultParent: 'builtin-skill-post-result-parent',
  postResultBoard: 'builtin-skill-post-result-board',
  postResultPr: 'builtin-skill-post-result-pr',
} as const;

/**
 * Helpers and quick agents work on the branch they were given, so they get the
 * working Identity instead of the durable one, whose standby-branch wording
 * tells an agent to start each task on a new branch (#2902).
 */
export function withWorkingIdentity<T extends { blocks: string[] }>(setup: T): T {
  if (!setup.blocks.includes(BUILTIN_BLOCK_IDS.identity)) return setup;
  // Never both: a setup that lists both gets the working one once, where it came first.
  return { ...setup, blocks: workingIdentityBlocks(setup.blocks) };
}

/** LF, whatever the checkout did: .gitattributes keeps builtin-text LF, and this is the backstop. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

function blockText(file: string): string {
  const text = BUILTIN_TEXT[file];
  if (text === undefined) throw new Error(`Built-in block text ${file} is missing; run scripts/sync-builtin-text.mjs`);
  return lf(text).trim();
}

function skillText(file: string): string {
  const text = BUILTIN_SKILL_TEXT[file];
  if (text === undefined) throw new Error(`Built-in skill file ${file} is missing; run scripts/sync-builtin-text.mjs`);
  return lf(text);
}

export function builtinParts(): BuiltinPart[] {
  return [
    ...BUILTIN_MANIFEST.blocks.map((b): BuiltinPart => ({
      id: b.id, kind: 'block', name: b.name, description: b.description,
      ...(b.retired && { retired: true as const }),
      payload: { content: blockText(b.file) },
    })),
    ...BUILTIN_MANIFEST.skills.map((sk): BuiltinPart => ({
      id: sk.id, kind: 'skill', name: sk.name, description: sk.description,
      ...(sk.retired && { retired: true as const }),
      payload: { skillName: sk.skillName, files: [{ path: 'SKILL.md', content: skillText(sk.file) }] },
    })),
    {
      id: CLUBHOUSE_MCP_PART_ID,
      kind: 'mcp',
      name: 'Clubhouse',
      description: 'Helpers, messages and the Dispatcher. Without it the agent can\'t orchestrate.',
      // Never delivered as written: the live bridge is injected per spawn with its own port and nonce.
      payload: { serverKey: 'clubhouse', transport: 'stdio', command: 'clubhouse-mcp-bridge' },
    },
    {
      // App-owned, not from the builder export: it ships with the handoff tools (#3344).
      id: PREPARE_HANDOFF_SKILL_ID,
      kind: 'skill',
      name: 'Prepare handoff',
      description: 'Summarise the task, choose what to send, and offer it to another agent or computer. Given to agents allowed to offer handoffs.',
      payload: { skillName: PREPARE_HANDOFF_SKILL_NAME, files: [{ path: 'SKILL.md', content: PREPARE_HANDOFF_SKILL_MD }] },
    },
  ];
}

/** Built-in templates. Not catalog assets: they hold references only (D3). */
export function builtinTemplates(): ManagedTemplate[] {
  return BUILTIN_MANIFEST.templates.map((t): ManagedTemplate => ({
    id: t.id, name: t.name, description: t.description, builtin: true,
    ...(t.retired && { retired: true as const }),
    setup: { blocks: [...t.blocks], skills: [...(t.skills ?? [])], mcps: [CLUBHOUSE_MCP_PART_ID] },
    settings: structuredClone(t.settings),
  }));
}

export const DEFAULT_HELPER_TEMPLATE_ID = 'builtin-template-helper';
