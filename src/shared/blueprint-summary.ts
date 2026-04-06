/**
 * Lightweight summary for blueprint gallery display.
 * Works with both existing CanvasBlueprint and future BlueprintManifest formats.
 */
export interface BlueprintSummary {
  /** Absolute path to the .json file on disk */
  filePath: string;
  /** Blueprint name (from manifest or filename) */
  name: string;
  /** Optional description */
  description?: string;
  /** Number of views/cards in the blueprint */
  viewCount: number;
  /** Number of agent-type views */
  agentCount: number;
  /** Number of wires (0 for legacy CanvasBlueprint format) */
  wireCount: number;
  /** Schema/format version */
  version: number;
  /** Project display name this blueprint was found in */
  source: string;
  /** ISO 8601 creation timestamp (from manifest or file stat) */
  createdAt?: string;
  /** Agent names found in the blueprint (for search) */
  agentNames: string[];
  /** True if this blueprint represents a single-agent template */
  isAgentTemplate?: boolean;
}
