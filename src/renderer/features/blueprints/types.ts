// ── Blueprint Manifest types ────────────────────────────────────────
//
// Local type definitions matching the Mission 50 schema.
// When src/shared/blueprint-types.ts lands (Mission 50), these can be
// replaced with re-exports from that module.

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
    views: BlueprintManifestView[];
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

export interface BlueprintManifestView {
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
  matchBy?: { name?: string; path?: string };
}
