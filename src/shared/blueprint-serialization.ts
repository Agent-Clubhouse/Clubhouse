import { randomUUID } from 'crypto';

import type { BlueprintManifest } from './blueprint-types';
import { validateBlueprint } from './blueprint-validation';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The highest schemaVersion this code fully understands. */
export const BLUEPRINT_SCHEMA_VERSION = 1;

/**
 * Serialize a BlueprintManifest to deterministic JSON (sorted keys, 2-space
 * indent). The output is stable across runs for the same input, which makes
 * it diff-friendly and suitable for content hashing.
 */
export function serializeBlueprint(manifest: BlueprintManifest): string {
  return JSON.stringify(manifest, sortedReplacer, 2);
}

/**
 * Parse a JSON string into a validated BlueprintManifest.
 *
 * Throws if the JSON is malformed or fails blueprint validation.
 * Warns (does not throw) when schemaVersion is newer than BLUEPRINT_SCHEMA_VERSION
 * so future blueprints degrade gracefully rather than crashing.
 * A missing schemaVersion is treated as version 1 for backward compatibility.
 */
export function deserializeBlueprint(json: string): BlueprintManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid blueprint JSON: ${(err as Error).message}`);
  }

  if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const bp = parsed as Record<string, unknown>;
    if (bp.schemaVersion === undefined || bp.schemaVersion === null) {
      bp.schemaVersion = BLUEPRINT_SCHEMA_VERSION;
    } else if (typeof bp.schemaVersion === 'number' && bp.schemaVersion > BLUEPRINT_SCHEMA_VERSION) {
      console.warn(
        `[blueprint-serialization] Blueprint schemaVersion ${bp.schemaVersion} is newer than supported version ${BLUEPRINT_SCHEMA_VERSION}. Some fields may be ignored.`,
      );
      bp.schemaVersion = BLUEPRINT_SCHEMA_VERSION;
    }
  }

  const result = validateBlueprint(parsed);
  if (!result.valid) {
    throw new Error(`Invalid blueprint:\n  - ${result.errors.join('\n  - ')}`);
  }

  return parsed as BlueprintManifest;
}

/**
 * Generate a new UUID v4 suitable for use as a BlueprintManifest.id.
 */
export function generateBlueprintId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * JSON.stringify replacer that sorts object keys for deterministic output.
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
