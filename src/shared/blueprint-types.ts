/**
 * Blueprint types — portable, shareable format for canvas configurations.
 *
 * A blueprint captures canvas views, wires, agent definitions, and project
 * references in a way that is portable across machines and repos.
 *
 * schemaVersion is pinned at 1 for the initial release; future schema changes
 * will bump this and require a migration layer.
 */

// ---------------------------------------------------------------------------
// Core manifest
// ---------------------------------------------------------------------------

export interface BlueprintManifest {
  /** Unique identifier (UUID v4). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional longer description of what the blueprint sets up. */
  description?: string;
  /** Semver string (e.g. "1.0.0"). */
  version: string;
  /** Must be 1 for the initial schema. */
  schemaVersion: 1;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Who created this blueprint (free-form). */
  createdBy?: string;
  /** App version used to export the blueprint. */
  exportedFrom?: string;
  /** Canvas layout definition. */
  canvas: BlueprintCanvas;
  /** Agent definitions referenced by views. */
  agents?: BlueprintAgentDef[];
  /** Project references used by views. */
  projects?: BlueprintProjectRef[];
  /** Plugin IDs that must be installed for this blueprint to work. */
  requiredPlugins?: string[];
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

export interface BlueprintCanvas {
  views: BlueprintView[];
  wires: BlueprintWire[];
  layout?: BlueprintLayout;
}

export interface BlueprintLayout {
  algorithm: string;
  direction?: string;
  centerViewRef?: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface BlueprintView {
  /** Local reference ID (unique within the blueprint, not a runtime ID). */
  refId: string;
  /** View type — 'agent' | 'anchor' | 'sticky-note' | 'zone' | 'plugin:*'. */
  type: string;
  /** Display label shown on the canvas card. */
  displayName: string;
  /** Position on the canvas. */
  position: { x: number; y: number };
  /** Optional explicit size. */
  size?: { width: number; height: number };
  /** Optional card colour. */
  color?: string;
  /** Optional inline content (e.g. sticky-note text). */
  content?: string;
  /** Arbitrary plugin/view-specific metadata. */
  metadata?: Record<string, unknown>;
  /** References a BlueprintAgentDef.refId. */
  agentRef?: string;
  /** References a BlueprintProjectRef.refId. */
  projectRef?: string;
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

export interface BlueprintWire {
  /** Source view refId. */
  sourceRef: string;
  /** Target view refId. */
  targetRef: string;
  /** Whether the wire is bidirectional. */
  bidirectional?: boolean;
  /** Per-direction instructions keyed by direction label. */
  instructions?: Record<string, string>;
  /** Tool names to disable on this wire. */
  disabledTools?: string[];
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface BlueprintAgentDef {
  /** Local reference ID (unique within the blueprint). */
  refId: string;
  /** Agent display name. */
  name: string;
  /** Preferred orchestrator identifier. */
  orchestrator?: string;
  /** Preferred model identifier. */
  model?: string;
  /** Inline instruction content or "@file:./relative-path.md" pointer. */
  instructionContent?: string;
  /** Skill identifiers to enable. */
  skills?: string[];
  /** MCP server identifiers to connect. */
  mcpServers?: string[];
  /** Whether the agent runs in free-agent mode. */
  freeAgent?: boolean;
  /** Whether the agent uses a git worktree. */
  useWorktree?: boolean;
  /** Whether the agent uses structured mode. */
  structured?: boolean;
  /** Matching hints for import-time agent resolution. */
  matchBy?: BlueprintAgentMatchBy;
}

export interface BlueprintAgentMatchBy {
  /** Exact name to match. */
  name?: string;
  /** Glob pattern to match against agent names. */
  namePattern?: string;
  /** Hash of instruction content for content-based matching. */
  instructionHash?: string;
}

// ---------------------------------------------------------------------------
// Project references
// ---------------------------------------------------------------------------

export interface BlueprintProjectRef {
  /** Local reference ID (unique within the blueprint). */
  refId: string;
  /** Project display name. */
  name: string;
  /** Path relative to the repo root. */
  relativePath?: string;
  /** Matching hints for import-time project resolution. */
  matchBy?: BlueprintProjectMatchBy;
}

export interface BlueprintProjectMatchBy {
  /** Exact project name. */
  name?: string;
  /** Filesystem path to match. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Blueprint Bundle — project-level multi-canvas export
// ---------------------------------------------------------------------------

/** A bundle wrapping multiple BlueprintManifests for project-level export/import. */
export interface BlueprintBundle {
  /** Unique identifier (UUID v4). */
  id: string;
  /** Bundle name (typically the project name). */
  name: string;
  /** Optional description. */
  description?: string;
  /** Semver string. */
  version: string;
  /** Must be 1 for the initial schema. */
  schemaVersion: 1;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** App version used to export the bundle. */
  exportedFrom?: string;
  /** The individual canvas blueprints in this bundle. */
  blueprints: BlueprintManifest[];
  /** Summary metadata for display purposes. */
  metadata?: BlueprintBundleMetadata;
}

export interface BlueprintBundleMetadata {
  /** Name of the source project. */
  projectName?: string;
  /** Number of canvases in the bundle. */
  canvasCount: number;
  /** Total view count across all canvases. */
  totalViews: number;
  /** Total wire count across all canvases. */
  totalWires: number;
  /** Total unique agent definitions across all canvases. */
  totalAgents: number;
}
