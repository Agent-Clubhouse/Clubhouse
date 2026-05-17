// ── Blueprint Export — canvas state → BlueprintManifest ──────────────
//
// Converts a live canvas (views, wires, agents, project) into a
// portable BlueprintManifest that can be saved/shared/imported.

import type { CanvasInstance, AgentCanvasView, PluginCanvasView, StickyNoteCanvasView, ZoneCanvasView, AnchorCanvasView } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { Agent, Project } from '../../../shared/types';
import type {
  BlueprintManifest,
  BlueprintView,
  BlueprintWire,
  BlueprintAgentDef,
  BlueprintProjectRef,
} from '../../../shared/blueprint-types';

// ── RefId generation ────────────────────────────────────────────────

/**
 * Derive a stable, compact refId from the entity's own stable ID.
 * Strips non-alphanumeric chars and takes the first 16 characters so refIds
 * remain human-readable in exported JSON while never shifting when other
 * entities are added or removed from the canvas (LB-CB-2026-05-05).
 */
function generateRefId(prefix: string, entityId: string): string {
  return `${prefix}_${entityId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
}

/** Kept for backward compatibility; no-op since the counter was removed. */
export function resetRefCounter(): void {}

// ── Slugify ─────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'blueprint';
}

// ── Export pipeline ─────────────────────────────────────────────────

export interface ExportContext {
  /** All agents indexed by ID, for extracting agent configs. */
  agents: Record<string, Agent>;
  /** All projects indexed by ID, for resolving project paths. */
  projects: Record<string, Project>;
  /** Wire definitions from the canvas store. */
  wireDefinitions: McpBindingEntry[];
  /** The project ID this canvas belongs to (if project-scoped). */
  projectId?: string;
  /** Absolute path of the exporting project (used to compute relative paths). */
  exportProjectPath?: string;
  /** App version string. */
  appVersion?: string;
}

/**
 * Compute a relative path from the export project root.
 * Falls back to basename if no export project path is available.
 */
function toRelativePath(absolutePath: string, exportProjectPath?: string): string {
  if (!exportProjectPath) {
    // Fallback: extract the last path segment as the project name
    const parts = absolutePath.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || absolutePath;
  }
  // Simple relative path computation without Node's path module
  // (renderer code — no access to Node path)
  if (absolutePath === exportProjectPath) return '.';
  if (absolutePath.startsWith(exportProjectPath + '/')) {
    return absolutePath.slice(exportProjectPath.length + 1);
  }
  // Different roots — compute by going up from export path
  const fromParts = exportProjectPath.split('/');
  const toParts = absolutePath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups = fromParts.length - common;
  const remainder = toParts.slice(common);
  return [...Array(ups).fill('..'), ...remainder].join('/');
}

/**
 * Export a canvas instance to a portable BlueprintManifest.
 *
 * Maps runtime view IDs to stable refIds, extracts agent configurations
 * from the agent store, remaps wire source/target to refIds, and
 * resolves project paths to relative paths.
 */
export function exportCanvasToBlueprint(
  canvas: CanvasInstance,
  ctx: ExportContext,
): BlueprintManifest {
  // Build viewId → refId mapping
  const viewIdToRefId = new Map<string, string>();
  // Also map agentId → refId for wire remapping (wires use agentId, not viewId)
  const agentIdToRefId = new Map<string, string>();
  // Track agent refIds (agentId → agentDef refId)
  const agentIdToAgentRef = new Map<string, string>();
  // Track project refIds (projectId → projectRef refId)
  const projectIdToProjectRef = new Map<string, string>();

  // Collect unique plugins for requiredPlugins
  const requiredPlugins = new Set<string>();

  // ── Phase 1: Generate refIds for all views ──────────────────────

  for (const view of canvas.views) {
    const refId = generateRefId('v', view.id);
    viewIdToRefId.set(view.id, refId);

    if (view.type === 'agent') {
      const agentView = view as AgentCanvasView;
      if (agentView.agentId) {
        agentIdToRefId.set(agentView.agentId, refId);
      }
    }
  }

  // ── Phase 2: Extract agent definitions ──────────────────────────

  const agentDefs: BlueprintAgentDef[] = [];

  for (const view of canvas.views) {
    if (view.type !== 'agent') continue;
    const agentView = view as AgentCanvasView;
    if (!agentView.agentId) continue;

    const agent = ctx.agents[agentView.agentId];
    if (!agent) continue;

    // Skip if we already have a def for this agent (dedup)
    if (agentIdToAgentRef.has(agent.id)) continue;

    const agentRefId = generateRefId('a', agent.id);
    agentIdToAgentRef.set(agent.id, agentRefId);

    agentDefs.push({
      refId: agentRefId,
      name: agent.name,
      orchestrator: agent.orchestrator ?? undefined,
      model: agent.model ?? undefined,
      freeAgent: agent.freeAgentMode ?? undefined,
      useWorktree: agent.worktreePath ? true : undefined,
      structured: agent.structuredMode ?? undefined,
      matchBy: {
        name: agent.name,
      },
    });
  }

  // ── Phase 3: Extract project references ─────────────────────────

  const projectRefs: BlueprintProjectRef[] = [];

  if (ctx.projectId) {
    const project = ctx.projects[ctx.projectId];
    if (project) {
      const projRefId = generateRefId('p', project.id);
      projectIdToProjectRef.set(project.id, projRefId);
      projectRefs.push({
        refId: projRefId,
        name: project.displayName || project.name,
        relativePath: toRelativePath(project.path, ctx.exportProjectPath),
        matchBy: {
          name: project.name,
          path: project.path,
        },
      });
    }
  }

  // Also capture project refs from agent views with different projectIds
  for (const view of canvas.views) {
    if (view.type !== 'agent') continue;
    const agentView = view as AgentCanvasView;
    if (!agentView.projectId || projectIdToProjectRef.has(agentView.projectId)) continue;

    const project = ctx.projects[agentView.projectId];
    if (!project) continue;

    const projRefId = generateRefId('p', project.id);
    projectIdToProjectRef.set(project.id, projRefId);
    projectRefs.push({
      refId: projRefId,
      name: project.displayName || project.name,
      relativePath: toRelativePath(project.path, ctx.exportProjectPath),
      matchBy: {
        name: project.name,
        path: project.path,
      },
    });
  }

  // ── Phase 4: Build BlueprintViews ───────────────────────────────

  // LB-CB-004: guard the refId lookup — every view should have been registered
  // in Phase 1, but a missing entry must not crash with a non-null assertion.
  const blueprintViews: BlueprintView[] = canvas.views.flatMap((view): BlueprintView[] => {
    const refId = viewIdToRefId.get(view.id);
    if (!refId) {
      console.warn(`[blueprint-export] view ${view.id} (${view.type}) has no refId — skipping`);
      return [] as BlueprintView[];
    }

    const bv: BlueprintView = {
      refId,
      type: view.type,
      displayName: view.displayName || view.title,
      position: { x: view.position.x, y: view.position.y },
      size: { width: view.size.width, height: view.size.height },
    };

    // Strip ephemeral metadata but keep config-relevant keys
    const metadata: Record<string, unknown> = {};
    const EPHEMERAL_KEYS = new Set([
      'agentId', 'agentName', 'projectName', 'orchestrator', 'model',
    ]);
    for (const [key, value] of Object.entries(view.metadata)) {
      if (!EPHEMERAL_KEYS.has(key)) {
        metadata[key] = value;
      }
    }
    if (Object.keys(metadata).length > 0) {
      bv.metadata = metadata;
    }

    switch (view.type) {
      case 'agent': {
        const agentView = view as AgentCanvasView;
        if (agentView.agentId) {
          bv.agentRef = agentIdToAgentRef.get(agentView.agentId);
        }
        if (agentView.projectId) {
          bv.projectRef = projectIdToProjectRef.get(agentView.projectId);
        }
        break;
      }
      case 'anchor': {
        const anchorView = view as AnchorCanvasView;
        bv.displayName = anchorView.label || bv.displayName;
        if (anchorView.autoCollapse !== undefined) {
          bv.metadata = { ...bv.metadata, autoCollapse: anchorView.autoCollapse };
        }
        break;
      }
      case 'plugin': {
        const pluginView = view as PluginCanvasView;
        bv.metadata = {
          ...bv.metadata,
          pluginWidgetType: pluginView.pluginWidgetType,
          pluginId: pluginView.pluginId,
        };
        requiredPlugins.add(pluginView.pluginId);
        break;
      }
      case 'sticky-note': {
        const stickyView = view as StickyNoteCanvasView;
        bv.content = stickyView.content;
        bv.color = stickyView.color;
        break;
      }
      case 'zone': {
        const zoneView = view as ZoneCanvasView;
        bv.metadata = { ...bv.metadata, themeId: zoneView.themeId };
        break;
      }
    }

    return [bv];
  });

  // ── Phase 5: Remap wires to refIds ──────────────────────────────

  const blueprintWires: BlueprintWire[] = [];

  for (const wire of ctx.wireDefinitions) {
    // Wires use agentId as source, targetId can be agentId, viewId, or GP id
    const sourceRef = agentIdToRefId.get(wire.agentId);
    const targetRef = agentIdToRefId.get(wire.targetId) ?? viewIdToRefId.get(wire.targetId);

    // Only include wires where both endpoints resolve to views on this canvas
    if (!sourceRef || !targetRef) continue;

    const bw: BlueprintWire = {
      sourceRef,
      targetRef,
    };

    if (wire.instructions && Object.keys(wire.instructions).length > 0) {
      bw.instructions = { ...wire.instructions };
    }
    if (wire.disabledTools && wire.disabledTools.length > 0) {
      bw.disabledTools = [...wire.disabledTools];
    }

    blueprintWires.push(bw);
  }

  // ── Phase 6: Assemble manifest ──────────────────────────────────

  const manifest: BlueprintManifest = {
    id: crypto.randomUUID(),
    name: canvas.name,
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    exportedFrom: ctx.appVersion,
    canvas: {
      views: blueprintViews,
      wires: blueprintWires,
      layout: {
        algorithm: canvas.elkAlgorithm,
        direction: canvas.elkDirection,
        centerViewRef: canvas.layoutCenterId
          ? viewIdToRefId.get(canvas.layoutCenterId)
          : undefined,
      },
    },
    agents: agentDefs.length > 0 ? agentDefs : undefined,
    projects: projectRefs.length > 0 ? projectRefs : undefined,
    requiredPlugins: requiredPlugins.size > 0 ? [...requiredPlugins] : undefined,
  };

  return manifest;
}

// ── Serialization helper ────────────────────────────────────────────

/**
 * JSON.stringify replacer that recursively sorts object keys for
 * deterministic output at all nesting levels.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/** Serialize a BlueprintManifest to deterministic JSON (sorted keys at all levels). */
export function serializeManifest(manifest: BlueprintManifest): string {
  return JSON.stringify(manifest, sortedReplacer, 2);
}
