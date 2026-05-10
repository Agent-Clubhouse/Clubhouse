// ── Blueprint Import — manifest → canvas with agent stubs ───────────
//
// Imports a BlueprintManifest and materialises it as a canvas with
// agent stub cards that resolve to existing agents or prompt creation.

import type { Agent } from '../../../shared/types';
import type {
  CanvasInstance,
  CanvasView,
  AgentCanvasView,
  AnchorCanvasView,
  PluginCanvasView,
  StickyNoteCanvasView,
  ZoneCanvasView,
} from '../../plugins/builtin/canvas/canvas-types';
import { DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT } from '../../plugins/builtin/canvas/canvas-types';
import { deduplicateDisplayName } from '../../plugins/builtin/canvas/canvas-types';
import { generateViewId, generateCanvasId, snapPosition } from '../../plugins/builtin/canvas/canvas-operations';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type {
  BlueprintManifest,
  BlueprintAgentDef,
  BlueprintWire,
  BlueprintProjectRef,
} from '../../../shared/blueprint-types';

// ── Match result types ──────────────────────────────────────────────

export type AgentMatchStatus = 'matched' | 'not_found' | 'ambiguous';

export interface AgentMatchResult {
  status: AgentMatchStatus;
  agents: Agent[];
}

export type StubBadge = 'connected' | 'not_found' | 'multiple_matches';

export interface AgentStubInfo {
  /** The blueprint agent definition this stub represents. */
  def: BlueprintAgentDef;
  /** Current match status badge colour. */
  badge: StubBadge;
  /** Matched agent(s) from the matching algorithm. */
  matchResult: AgentMatchResult;
  /** The canvas view ID hosting this stub. */
  viewId: string;
  /** Set to true once the user confirms/creates the binding. */
  bound: boolean;
  /** The bound agent ID (set after confirm/create). */
  boundAgentId?: string;
}

export interface ProjectMatchResult {
  refId: string;
  name: string;
  matchedProjectId?: string;
  matchedProjectPath?: string;
}

export interface ImportResult {
  canvas: CanvasInstance;
  stubs: AgentStubInfo[];
  projectMatches: ProjectMatchResult[];
  pendingWires: BlueprintWire[];
  /** Map from blueprint refId → runtime canvas viewId. */
  refIdToViewId: Map<string, string>;
}

// ── Validation ──────────────────────────────────────────────────────

export function validateManifest(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Expected an object'] };
  }

  const m = data as Record<string, unknown>;

  if ((m as any).schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${(m as any).schemaVersion ?? 'missing'} (expected 1)`);
  }
  if (!m.name || typeof m.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  }
  if (!m.id || typeof m.id !== 'string') {
    errors.push('Missing or invalid "id" field');
  }

  const canvas = m.canvas as Record<string, unknown> | undefined;
  if (!canvas || typeof canvas !== 'object') {
    errors.push('Missing or invalid "canvas" field');
    return { valid: false, errors };
  }

  if (!Array.isArray(canvas.views)) {
    errors.push('canvas.views must be an array');
    return { valid: false, errors };
  }

  // Check refId uniqueness across views
  const viewRefIds = new Set<string>();
  for (let i = 0; i < canvas.views.length; i++) {
    const v = canvas.views[i] as Record<string, unknown>;
    if (!v.refId || typeof v.refId !== 'string') {
      errors.push(`View at index ${i}: missing refId`);
      continue;
    }
    if (viewRefIds.has(v.refId as string)) {
      errors.push(`Duplicate view refId: "${v.refId}"`);
    }
    viewRefIds.add(v.refId as string);
  }

  // Validate wires reference existing view refIds
  if (Array.isArray(canvas.wires)) {
    for (let i = 0; i < canvas.wires.length; i++) {
      const w = canvas.wires[i] as Record<string, unknown>;
      if (!viewRefIds.has(w.sourceRef as string)) {
        errors.push(`Wire at index ${i}: sourceRef "${w.sourceRef}" not found in views`);
      }
      if (!viewRefIds.has(w.targetRef as string)) {
        errors.push(`Wire at index ${i}: targetRef "${w.targetRef}" not found in views`);
      }
    }
  }

  // Validate agent refs
  const agentRefIds = new Set<string>();
  if (Array.isArray(m.agents)) {
    for (const a of m.agents as Record<string, unknown>[]) {
      if (a.refId && typeof a.refId === 'string') {
        if (agentRefIds.has(a.refId as string)) {
          errors.push(`Duplicate agent refId: "${a.refId}"`);
        }
        agentRefIds.add(a.refId as string);
      }
    }
  }

  // Validate agentRef on views points to a defined agent
  for (const v of canvas.views as Record<string, unknown>[]) {
    if (v.agentRef && !agentRefIds.has(v.agentRef as string)) {
      errors.push(`View "${v.refId}": agentRef "${v.agentRef}" not found in agents`);
    }
  }

  // Validate project refs
  const projectRefIds = new Set<string>();
  if (Array.isArray(m.projects)) {
    for (const p of m.projects as Record<string, unknown>[]) {
      if (p.refId && typeof p.refId === 'string') {
        if (projectRefIds.has(p.refId as string)) {
          errors.push(`Duplicate project refId: "${p.refId}"`);
        }
        projectRefIds.add(p.refId as string);
      }
    }
  }

  for (const v of canvas.views as Record<string, unknown>[]) {
    if (v.projectRef && !projectRefIds.has(v.projectRef as string)) {
      errors.push(`View "${v.refId}": projectRef "${v.projectRef}" not found in projects`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Agent matching ──────────────────────────────────────────────────

/**
 * Simple glob-like pattern matching for agent names.
 * Supports `*` (any chars) and `?` (single char).
 */
function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return regex.test(text);
}

export function matchAgent(def: BlueprintAgentDef, existingAgents: Agent[]): AgentMatchResult {
  // 1. Exact name match via matchBy.name
  if (def.matchBy?.name) {
    const exact = existingAgents.filter((a) => a.name === def.matchBy!.name);
    if (exact.length === 1) return { status: 'matched', agents: exact };
    if (exact.length > 1) return { status: 'ambiguous', agents: exact };
  }

  // 2. Pattern match via matchBy.namePattern
  if (def.matchBy?.namePattern) {
    const matched = existingAgents.filter((a) => globMatch(def.matchBy!.namePattern!, a.name));
    if (matched.length === 1) return { status: 'matched', agents: matched };
    if (matched.length > 1) return { status: 'ambiguous', agents: matched };
  }

  // 3. Instruction hash match
  if (def.matchBy?.instructionHash && def.instructionContent) {
    // Instruction hash matching requires reading agent files from disk — not
    // available in the renderer.  Return not_found rather than falling through
    // to name matching, which could silently bind the wrong agent when multiple
    // agents share the same name (LB-CB-005).
    return { status: 'not_found', agents: [] };
  }

  // 4. Fallback: case-insensitive match on def.name
  const fallback = existingAgents.filter(
    (a) => a.name.toLowerCase() === def.name.toLowerCase(),
  );
  if (fallback.length === 1) return { status: 'matched', agents: fallback };
  if (fallback.length > 1) return { status: 'ambiguous', agents: fallback };

  return { status: 'not_found', agents: [] };
}

// ── Badge from match status ─────────────────────────────────────────

function badgeFromMatch(result: AgentMatchResult): StubBadge {
  switch (result.status) {
    case 'matched':
      return 'connected';
    case 'not_found':
      return 'not_found';
    case 'ambiguous':
      return 'multiple_matches';
  }
}

// ── Project matching ────────────────────────────────────────────────

export interface ExistingProject {
  id: string;
  name: string;
  path: string;
}

export function matchProject(
  ref: BlueprintProjectRef,
  existingProjects: ExistingProject[],
): ProjectMatchResult {
  // Match by path first (most specific)
  if (ref.matchBy?.path) {
    const byPath = existingProjects.find((p) =>
      p.path.endsWith(ref.matchBy!.path!) || p.path === ref.matchBy!.path,
    );
    if (byPath) {
      return { refId: ref.refId, name: ref.name, matchedProjectId: byPath.id, matchedProjectPath: byPath.path };
    }
  }

  // Match by name
  const matchName = ref.matchBy?.name || ref.name;
  const byName = existingProjects.find(
    (p) => p.name.toLowerCase() === matchName.toLowerCase(),
  );
  if (byName) {
    return { refId: ref.refId, name: ref.name, matchedProjectId: byName.id, matchedProjectPath: byName.path };
  }

  // Match by relativePath
  if (ref.relativePath) {
    const byRelPath = existingProjects.find((p) => p.path.endsWith(ref.relativePath!));
    if (byRelPath) {
      return { refId: ref.refId, name: ref.name, matchedProjectId: byRelPath.id, matchedProjectPath: byRelPath.path };
    }
  }

  return { refId: ref.refId, name: ref.name };
}

// ── Canvas view type mapping ────────────────────────────────────────

function mapViewType(type: string): 'agent' | 'anchor' | 'plugin' | 'sticky-note' | 'zone' {
  switch (type) {
    case 'agent':
    case 'anchor':
    case 'plugin':
    case 'sticky-note':
    case 'zone':
      return type;
    default:
      // Plugin-prefixed types (e.g. "plugin:files:file-viewer")
      if (type.startsWith('plugin:')) return 'plugin';
      return 'agent';
  }
}

// ── Main import function ────────────────────────────────────────────

export function importBlueprint(
  manifest: BlueprintManifest,
  existingAgents: Agent[],
  existingProjects: ExistingProject[],
  targetProjectId?: string,
): ImportResult {
  // 1. Validate
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid blueprint: ${validation.errors.join('; ')}`);
  }

  // 2. Match projects
  const projectMatches: ProjectMatchResult[] = (manifest.projects || []).map((ref) =>
    matchProject(ref, existingProjects),
  );
  const projectRefToId = new Map<string, string>();
  for (const pm of projectMatches) {
    if (pm.matchedProjectId) {
      projectRefToId.set(pm.refId, pm.matchedProjectId);
    }
  }

  // 3. Build agent def lookup
  const agentDefMap = new Map<string, BlueprintAgentDef>();
  for (const agentDef of manifest.agents || []) {
    agentDefMap.set(agentDef.refId, agentDef);
  }

  // 4. Create canvas views from manifest views
  const refIdToViewId = new Map<string, string>();
  const existingNames: string[] = [];
  const stubs: AgentStubInfo[] = [];

  const views: CanvasView[] = manifest.canvas.views.map((bv, index): CanvasView => {
    const viewId = generateViewId();
    refIdToViewId.set(bv.refId, viewId);

    const displayName = deduplicateDisplayName(bv.displayName || bv.type, existingNames);
    existingNames.push(displayName);

    // LB-CB-003: sanitize position and size — NaN/Infinity/negative values produce
    // invisible or off-screen cards post-import.
    const rawPos = bv.position || { x: 0, y: 0 };
    const position = snapPosition({
      x: Number.isFinite(rawPos.x) ? rawPos.x : 0,
      y: Number.isFinite(rawPos.y) ? rawPos.y : 0,
    });
    const rawSize = bv.size as { width?: unknown; height?: unknown } | undefined ?? {};
    const size = {
      width: Number.isFinite(rawSize.width as number) && (rawSize.width as number) > 0
        ? rawSize.width as number
        : DEFAULT_VIEW_WIDTH,
      height: Number.isFinite(rawSize.height as number) && (rawSize.height as number) > 0
        ? rawSize.height as number
        : DEFAULT_VIEW_HEIGHT,
    };
    const viewType = mapViewType(bv.type);

    const base = {
      id: viewId,
      position,
      size,
      title: bv.displayName || bv.type,
      displayName,
      zIndex: index,
      metadata: (bv.metadata || {}) as Record<string, string>,
    };

    // Resolve project ref for agent views
    const resolvedProjectId = bv.projectRef
      ? projectRefToId.get(bv.projectRef) || targetProjectId
      : targetProjectId;

    switch (viewType) {
      case 'agent': {
        // Run agent matching if this view has an agentRef
        const agentDef = bv.agentRef ? agentDefMap.get(bv.agentRef) : undefined;
        let agentId: string | null = null;

        if (agentDef) {
          const matchResult = matchAgent(agentDef, existingAgents);
          const badge = badgeFromMatch(matchResult);

          // If matched, pre-populate the agentId
          if (matchResult.status === 'matched' && matchResult.agents.length === 1) {
            agentId = matchResult.agents[0].id;
          }

          stubs.push({
            def: agentDef,
            badge,
            matchResult,
            viewId,
            bound: matchResult.status === 'matched' && matchResult.agents.length === 1,
            boundAgentId: agentId || undefined,
          });

          // Store match status in metadata for rendering
          base.metadata = {
            ...base.metadata,
            blueprintStub: 'true',
            blueprintBadge: badge,
            blueprintAgentName: agentDef.name,
          };
        }

        return {
          ...base,
          type: 'agent' as const,
          agentId,
          projectId: resolvedProjectId,
        } satisfies AgentCanvasView;
      }

      case 'anchor':
        return {
          ...base,
          type: 'anchor' as const,
          label: bv.displayName || displayName,
        } satisfies AnchorCanvasView;

      case 'plugin': {
        // Extract plugin info from the type string or metadata
        const pluginWidgetType = (bv.metadata?.pluginWidgetType as string) || bv.type;
        const pluginId = (bv.metadata?.pluginId as string) || bv.type.split(':')[1] || '';
        return {
          ...base,
          type: 'plugin' as const,
          pluginWidgetType,
          pluginId,
        } satisfies PluginCanvasView;
      }

      case 'sticky-note':
        return {
          ...base,
          type: 'sticky-note' as const,
          content: bv.content || '',
          color: bv.color || 'yellow',
        } satisfies StickyNoteCanvasView;

      case 'zone':
        return {
          ...base,
          type: 'zone' as const,
          themeId: (bv.metadata?.themeId as string) || 'catppuccin-mocha',
          containedViewIds: [],
        } satisfies ZoneCanvasView;
    }
  });

  // 5. Build canvas instance
  const layout = manifest.canvas.layout;
  const canvas: CanvasInstance = {
    id: generateCanvasId(),
    name: manifest.name || 'Imported Blueprint',
    views,
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: views.length,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: (layout?.algorithm as CanvasInstance['elkAlgorithm']) || 'layered',
    elkDirection: (layout?.direction as CanvasInstance['elkDirection']) || 'RIGHT',
    layoutCenterId: layout?.centerViewRef
      ? refIdToViewId.get(layout.centerViewRef) || null
      : null,
  };

  return {
    canvas,
    stubs,
    projectMatches,
    pendingWires: manifest.canvas.wires || [],
    refIdToViewId,
  };
}

// ── Wire creation (deferred) ────────────────────────────────────────

/**
 * Resolve and create wires for bound agents. Only creates wires where
 * both source and target views have bound agents.
 *
 * Returns the wires that were successfully created and those still pending.
 */
export function resolveAndCreateWires(
  pendingWires: BlueprintWire[],
  refIdToViewId: Map<string, string>,
  stubs: AgentStubInfo[],
  canvasViews: CanvasView[],
): { created: McpBindingEntry[]; remaining: BlueprintWire[] } {
  const created: McpBindingEntry[] = [];
  const remaining: BlueprintWire[] = [];

  // Build lookup: viewId → agentId for bound agent views
  const viewIdToAgentId = new Map<string, string>();
  for (const stub of stubs) {
    if (stub.bound && stub.boundAgentId) {
      viewIdToAgentId.set(stub.viewId, stub.boundAgentId);
    }
  }
  // Also check non-stub agent views that already have agentIds
  for (const view of canvasViews) {
    if (view.type === 'agent' && (view as AgentCanvasView).agentId) {
      viewIdToAgentId.set(view.id, (view as AgentCanvasView).agentId!);
    }
  }

  // Build lookup: viewId → target info for non-agent views (GP widgets, browsers, etc.)
  const viewIdToTarget = new Map<string, { id: string; kind: McpBindingEntry['targetKind']; name: string }>();
  for (const view of canvasViews) {
    if (view.type === 'plugin') {
      const pv = view as PluginCanvasView;
      if (pv.pluginWidgetType.includes('group-project')) {
        const gpId = view.metadata?.groupProjectId as string;
        if (gpId) {
          viewIdToTarget.set(view.id, { id: gpId, kind: 'group-project', name: view.displayName });
        }
      } else if (pv.pluginWidgetType.includes('browser')) {
        viewIdToTarget.set(view.id, { id: view.id, kind: 'browser', name: view.displayName });
      }
    }
  }

  for (const wire of pendingWires) {
    const sourceViewId = refIdToViewId.get(wire.sourceRef);
    const targetViewId = refIdToViewId.get(wire.targetRef);

    if (!sourceViewId || !targetViewId) {
      remaining.push(wire);
      continue;
    }

    const sourceAgentId = viewIdToAgentId.get(sourceViewId);
    if (!sourceAgentId) {
      remaining.push(wire);
      continue;
    }

    // Target can be an agent or a non-agent widget
    const targetAgentId = viewIdToAgentId.get(targetViewId);
    const targetInfo = viewIdToTarget.get(targetViewId);

    if (targetAgentId) {
      // Agent-to-agent wire
      const entry: McpBindingEntry = {
        agentId: sourceAgentId,
        targetId: targetAgentId,
        targetKind: 'agent',
        label: `Wire to agent`,
        instructions: wire.instructions,
        disabledTools: wire.disabledTools,
      };
      created.push(entry);

      // If bidirectional, create reverse wire too
      if (wire.bidirectional) {
        created.push({
          agentId: targetAgentId,
          targetId: sourceAgentId,
          targetKind: 'agent',
          label: `Wire to agent`,
          instructions: wire.instructions,
          disabledTools: wire.disabledTools,
        });
      }
    } else if (targetInfo) {
      // Agent-to-widget wire
      const entry: McpBindingEntry = {
        agentId: sourceAgentId,
        targetId: targetInfo.id,
        targetKind: targetInfo.kind,
        label: `Wire to ${targetInfo.name}`,
        instructions: wire.instructions,
        disabledTools: wire.disabledTools,
      };
      created.push(entry);
    } else {
      remaining.push(wire);
    }
  }

  return { created, remaining };
}

// ── Bind agent to stub ──────────────────────────────────────────────

/**
 * Bind an agent to a stub card. Updates the stub state and returns
 * any newly-creatable wires.
 */
export function bindAgentToStub(
  stubs: AgentStubInfo[],
  viewId: string,
  agentId: string,
): AgentStubInfo[] {
  return stubs.map((stub) => {
    if (stub.viewId !== viewId) return stub;
    return {
      ...stub,
      bound: true,
      boundAgentId: agentId,
      badge: 'connected' as StubBadge,
    };
  });
}
