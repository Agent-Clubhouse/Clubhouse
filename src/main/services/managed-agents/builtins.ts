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
 * Built-ins the maintainer cut are retired, not deleted (D71): they stay
 * installed and are still delivered to agents and templates that list them,
 * but the UI hides them from the library and from new choices.
 */
import manifestJson from './builtin-text/manifest.json';
import { BUILTIN_TEXT } from './builtin-text/index';
import { CLUBHOUSE_MCP_PART_ID, type ManagedTemplate, type ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import type { BlockAssetPayload, McpAssetPayload } from '../../../shared/asset-catalog-types';

export interface BuiltinPart {
  id: string;
  kind: 'block' | 'mcp';
  name: string;
  description: string;
  /** Cut by the maintainer: still installed and delivered, hidden from new choices. */
  retired?: true;
  payload: BlockAssetPayload | McpAssetPayload;
}

/** The shape of `builtin-text/manifest.json`. */
export interface BuiltinManifest {
  blocks: Array<{ id: string; name: string; description: string; file: string; retired?: boolean }>;
  templates: Array<{ id: string; name: string; description: string; blocks: string[]; settings: ManagedTemplateSettings; retired?: boolean }>;
}

export const BUILTIN_MANIFEST = manifestJson as BuiltinManifest;

/**
 * Ids code refers to. Ids are stable forever: agents and templates point at
 * them. The manifest is the full list; a test checks each of these is in it.
 */
export const BUILTIN_BLOCK_IDS = {
  identity: 'builtin-block-identity',
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

function blockText(file: string): string {
  const text = BUILTIN_TEXT[file];
  if (text === undefined) throw new Error(`Built-in block text ${file} is missing; run scripts/sync-builtin-text.mjs`);
  return text.trim();
}

export function builtinParts(): BuiltinPart[] {
  return [
    ...BUILTIN_MANIFEST.blocks.map((b): BuiltinPart => ({
      id: b.id, kind: 'block', name: b.name, description: b.description,
      ...(b.retired && { retired: true as const }),
      payload: { content: blockText(b.file) },
    })),
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

/** Built-in templates. Not catalog assets: they hold references only (D3). */
export function builtinTemplates(): ManagedTemplate[] {
  return BUILTIN_MANIFEST.templates.map((t): ManagedTemplate => ({
    id: t.id, name: t.name, description: t.description, builtin: true,
    ...(t.retired && { retired: true as const }),
    setup: { blocks: [...t.blocks], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] },
    settings: structuredClone(t.settings),
  }));
}

export const DEFAULT_HELPER_TEMPLATE_ID = 'builtin-template-helper';
