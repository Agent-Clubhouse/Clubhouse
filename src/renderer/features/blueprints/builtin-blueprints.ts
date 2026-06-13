// ── Built-in Blueprint Templates ───────────────────────────────────
//
// Ships preconfigured squad blueprints that appear in the Blueprint Gallery
// alongside user/project blueprints. Selecting one creates a canvas with
// agent stub cards (Group PM + developers + QA) wired to the PM, which the
// user then binds to existing agents or creates fresh.
//
// These are in-memory manifests (not file-backed). They are surfaced to the
// gallery via listBuiltinBlueprintSummaries() and identified by a synthetic
// `builtin://<id>` filePath so the import path can resolve them without disk IO.

import type {
  BlueprintManifest,
  BlueprintAgentDef,
  BlueprintView,
  BlueprintWire,
} from '../../../shared/blueprint-types';
import type { BlueprintSummary } from '../../../shared/blueprint-summary';

/** Synthetic filePath prefix marking a blueprint as built-in (not on disk). */
export const BUILTIN_BLUEPRINT_PREFIX = 'builtin://';

/**
 * Fixed creation timestamp for built-in templates. Kept constant (rather than
 * `Date.now()`) so the manifests are deterministic and snapshot-testable.
 */
const BUILTIN_CREATED_AT = '2026-06-13T00:00:00.000Z';

const GRID_SPACING = 320;
const COLS_PER_ROW = 3;
const AGENT_VIEW_SIZE = { width: 280, height: 220 };

// ── Agent def builders ──────────────────────────────────────────────

function groupPMAgent(): BlueprintAgentDef {
  return {
    refId: 'agent_gp',
    name: 'Group PM',
    orchestrator: 'claude',
    skills: [],
  };
}

function devAgent(n: number): BlueprintAgentDef {
  return {
    refId: `agent_dev_${n}`,
    name: `Developer ${n}`,
    orchestrator: 'claude',
    skills: ['mission', 'build', 'test', 'validate-changes', 'create-pr'],
    useWorktree: true,
  };
}

function qaAgent(n: number): BlueprintAgentDef {
  return {
    refId: `agent_qa_${n}`,
    name: `QA ${n}`,
    orchestrator: 'claude',
    skills: ['test', 'code-review', 'validate-changes'],
  };
}

// ── Layout ──────────────────────────────────────────────────────────

/** Grid positions for `count` cards: 3 per row, top-down. */
function gridPositions(count: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    positions.push({
      x: (i % COLS_PER_ROW) * GRID_SPACING,
      y: Math.floor(i / COLS_PER_ROW) * GRID_SPACING,
    });
  }
  return positions;
}

function agentView(def: BlueprintAgentDef, position: { x: number; y: number }): BlueprintView {
  return {
    refId: def.refId,
    type: 'agent',
    displayName: def.name,
    agentRef: def.refId,
    position,
    size: { ...AGENT_VIEW_SIZE },
  };
}

/** Bidirectional wires from the Group PM to every other agent. */
function pmFanoutWires(pmRefId: string, otherRefIds: string[]): BlueprintWire[] {
  return otherRefIds.map((targetRef) => ({
    sourceRef: pmRefId,
    targetRef,
    bidirectional: true,
  }));
}

// ── Manifest assembly ───────────────────────────────────────────────

function buildSquadManifest(
  id: string,
  name: string,
  description: string,
  agents: BlueprintAgentDef[],
): BlueprintManifest {
  const positions = gridPositions(agents.length);
  const views = agents.map((def, i) => agentView(def, positions[i]));
  const [pm, ...rest] = agents;
  const wires = pmFanoutWires(pm.refId, rest.map((a) => a.refId));

  return {
    id: `blueprint_${id}`,
    name,
    description,
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: BUILTIN_CREATED_AT,
    createdBy: 'system',
    canvas: {
      views,
      wires,
      layout: { algorithm: 'layered', direction: 'DOWN' },
    },
    agents,
  };
}

/**
 * Small Squad — Group PM + 3 Developers + 1 QA (5 agents).
 * Ideal for focused feature work.
 */
export function createSmallSquadBlueprint(): BlueprintManifest {
  const agents = [
    groupPMAgent(),
    devAgent(1),
    devAgent(2),
    devAgent(3),
    qaAgent(1),
  ];
  return buildSquadManifest(
    'small-squad',
    'Small Squad',
    'Group PM + 3 Developers + 1 QA. Ideal for focused feature work.',
    agents,
  );
}

/**
 * Large Squad — Group PM + 6 Developers + 2 QA (9 agents).
 * Ideal for larger projects with parallel workstreams.
 */
export function createLargeSquadBlueprint(): BlueprintManifest {
  const agents = [
    groupPMAgent(),
    devAgent(1),
    devAgent(2),
    devAgent(3),
    devAgent(4),
    devAgent(5),
    devAgent(6),
    qaAgent(1),
    qaAgent(2),
  ];
  return buildSquadManifest(
    'large-squad',
    'Large Squad',
    'Group PM + 6 Developers + 2 QA. Ideal for larger projects and parallel workstreams.',
    agents,
  );
}

// ── Registry ────────────────────────────────────────────────────────

interface BuiltinBlueprintEntry {
  id: string;
  factory: () => BlueprintManifest;
}

export const BUILTIN_BLUEPRINTS: BuiltinBlueprintEntry[] = [
  { id: 'small-squad', factory: createSmallSquadBlueprint },
  { id: 'large-squad', factory: createLargeSquadBlueprint },
];

/** The synthetic filePath for a built-in blueprint id. */
export function builtinBlueprintFilePath(id: string): string {
  return `${BUILTIN_BLUEPRINT_PREFIX}${id}`;
}

/** True if a filePath refers to a built-in blueprint. */
export function isBuiltinBlueprintPath(filePath: string): boolean {
  return filePath.startsWith(BUILTIN_BLUEPRINT_PREFIX);
}

/** Resolve a built-in blueprint manifest by id or `builtin://`-prefixed path. */
export function getBuiltinBlueprint(idOrPath: string): BlueprintManifest | undefined {
  const id = idOrPath.startsWith(BUILTIN_BLUEPRINT_PREFIX)
    ? idOrPath.slice(BUILTIN_BLUEPRINT_PREFIX.length)
    : idOrPath;
  const entry = BUILTIN_BLUEPRINTS.find((b) => b.id === id);
  return entry ? entry.factory() : undefined;
}

/** Convert a manifest into a gallery summary. */
function toSummary(manifest: BlueprintManifest, id: string): BlueprintSummary {
  const views = manifest.canvas.views;
  const agentViews = views.filter((v) => v.type === 'agent');
  return {
    filePath: builtinBlueprintFilePath(id),
    name: manifest.name,
    description: manifest.description,
    viewCount: views.length,
    agentCount: agentViews.length,
    wireCount: manifest.canvas.wires.length,
    version: manifest.schemaVersion,
    source: 'Built-in',
    createdAt: manifest.createdAt,
    agentNames: (manifest.agents ?? []).map((a) => a.name),
  };
}

/** Gallery summaries for all built-in blueprints. */
export function listBuiltinBlueprintSummaries(): BlueprintSummary[] {
  return BUILTIN_BLUEPRINTS.map((entry) => toSummary(entry.factory(), entry.id));
}
