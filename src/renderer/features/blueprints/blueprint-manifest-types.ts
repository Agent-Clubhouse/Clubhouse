// ── Blueprint Manifest types (Mission 50 schema) ────────────────────
//
// Portable, shareable format for canvas configurations.
// These types match the BlueprintManifest schema from Mission 50.
// Once Mission 50's src/shared/blueprint-types.ts is merged,
// these should be consolidated with the shared types.

export interface BlueprintManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  schemaVersion: 1;
  createdAt: string;
  createdBy?: string;
  exportedFrom?: string;
  canvas: {
    views: BlueprintView[];
    wires: BlueprintWire[];
    layout?: {
      algorithm: string;
      direction?: string;
      centerViewRef?: string;
    };
  };
  agents?: BlueprintAgentDef[];
  projects?: BlueprintProjectRef[];
  requiredPlugins?: string[];
}

export interface BlueprintView {
  refId: string;
  type: string;
  displayName: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  color?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  agentRef?: string;
  projectRef?: string;
}

export interface BlueprintWire {
  sourceRef: string;
  targetRef: string;
  bidirectional?: boolean;
  instructions?: Record<string, string>;
  disabledTools?: string[];
}

export interface BlueprintAgentDef {
  refId: string;
  name: string;
  orchestrator?: string;
  model?: string;
  instructionContent?: string;
  skills?: string[];
  mcpServers?: string[];
  freeAgent?: boolean;
  useWorktree?: boolean;
  structured?: boolean;
  matchBy?: {
    name?: string;
    namePattern?: string;
    instructionHash?: string;
  };
}

export interface BlueprintProjectRef {
  refId: string;
  name: string;
  relativePath?: string;
  matchBy?: {
    name?: string;
    path?: string;
  };
}
