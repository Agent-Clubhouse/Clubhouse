// ── Agent Template Export — agent config → BlueprintManifest ─────────
//
// Creates a single-agent BlueprintManifest from an agent's configuration,
// suitable for sharing as a reusable template. The exported manifest
// includes a single agent card view + the agent's BlueprintAgentDef
// with instruction content inlined.

import type { Agent } from '../../../shared/types';
import type {
  BlueprintManifest,
  BlueprintAgentDef,
  BlueprintView,
} from '../../../shared/blueprint-types';
import { DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT } from '../../plugins/builtin/canvas/canvas-types';

// ── Export function ─────────────────────────────────────────────────

export interface AgentTemplateExportOptions {
  /** Instruction content to inline in the template. */
  instructionContent?: string;
  /** Skill names active for this agent. */
  skills?: string[];
  /** MCP server IDs configured for this agent. */
  mcpServers?: string[];
  /** Optional description for the template. */
  description?: string;
  /** App version string. */
  appVersion?: string;
}

/**
 * Export a single agent's configuration as a BlueprintManifest template.
 *
 * The result is a valid BlueprintManifest with:
 * - One agent card view at the origin
 * - One BlueprintAgentDef with full config (orchestrator, model, etc.)
 * - Instruction content inlined (not as file path)
 * - No wires (single agent, nothing to connect)
 * - Metadata flag `isAgentTemplate: true` for gallery display
 */
export function exportAgentAsTemplate(
  agent: Agent,
  options: AgentTemplateExportOptions = {},
): BlueprintManifest {
  const agentRefId = 'a_1';
  const viewRefId = 'v_1';

  const agentDef: BlueprintAgentDef = {
    refId: agentRefId,
    name: agent.name,
    orchestrator: agent.orchestrator ?? undefined,
    model: agent.model ?? undefined,
    instructionContent: options.instructionContent || undefined,
    skills: options.skills?.length ? options.skills : undefined,
    mcpServers: options.mcpServers?.length ? options.mcpServers : undefined,
    freeAgent: agent.freeAgentMode ?? undefined,
    useWorktree: agent.worktreePath ? true : undefined,
    structured: agent.structuredMode ?? undefined,
    matchBy: {
      name: agent.name,
    },
  };

  const view: BlueprintView = {
    refId: viewRefId,
    type: 'agent',
    displayName: agent.name,
    position: { x: 0, y: 0 },
    size: { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT },
    agentRef: agentRefId,
    metadata: {
      isAgentTemplate: true,
    },
  };

  return {
    id: crypto.randomUUID(),
    name: `${agent.name} Template`,
    description: options.description || `Agent template exported from ${agent.name}`,
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    exportedFrom: options.appVersion,
    canvas: {
      views: [view],
      wires: [],
    },
    agents: [agentDef],
  };
}

// ── Detection helper ────────────────────────────────────────────────

/**
 * Check if a BlueprintManifest represents an agent template
 * (single agent card, no wires).
 */
export function isAgentTemplate(manifest: BlueprintManifest): boolean {
  const views = manifest.canvas?.views ?? [];
  const wires = manifest.canvas?.wires ?? [];
  const agents = manifest.agents ?? [];

  return (
    views.length === 1 &&
    views[0].type === 'agent' &&
    agents.length === 1 &&
    wires.length === 0
  );
}

/**
 * Extract the agent definition from an agent template manifest.
 * Returns undefined if the manifest is not an agent template.
 */
export function extractAgentDef(manifest: BlueprintManifest): BlueprintAgentDef | undefined {
  if (!isAgentTemplate(manifest)) return undefined;
  return manifest.agents?.[0];
}
