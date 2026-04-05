import type {
  BlueprintManifest,
  BlueprintView,
  BlueprintWire,
  BlueprintAgentDef,
  BlueprintProjectRef,
  BlueprintCanvas,
} from './blueprint-types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a blueprint manifest at runtime.
 *
 * Checks structural shape, required fields, refId uniqueness, dangling
 * wire/agent/project references, and schemaVersion.
 */
export function validateBlueprint(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Blueprint must be a non-null object'] };
  }

  const bp = data as Record<string, unknown>;

  // -- top-level required scalars ------------------------------------------
  validateString(bp, 'id', errors);
  validateString(bp, 'name', errors);
  validateString(bp, 'version', errors);
  validateString(bp, 'createdAt', errors);

  if (bp.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${JSON.stringify(bp.schemaVersion)}`);
  }

  // -- optional top-level scalars ------------------------------------------
  if (bp.description !== undefined) validateOptionalString(bp, 'description', errors);
  if (bp.createdBy !== undefined) validateOptionalString(bp, 'createdBy', errors);
  if (bp.exportedFrom !== undefined) validateOptionalString(bp, 'exportedFrom', errors);

  // -- canvas (required) ---------------------------------------------------
  if (bp.canvas == null || typeof bp.canvas !== 'object' || Array.isArray(bp.canvas)) {
    errors.push('canvas must be a non-null object');
    return { valid: errors.length === 0, errors };
  }

  const canvas = bp.canvas as Record<string, unknown>;
  const viewRefIds = new Set<string>();
  const agentRefIds = new Set<string>();
  const projectRefIds = new Set<string>();

  // -- canvas.views --------------------------------------------------------
  if (!Array.isArray(canvas.views)) {
    errors.push('canvas.views must be an array');
  } else {
    for (let i = 0; i < canvas.views.length; i++) {
      validateView(canvas.views[i], i, viewRefIds, errors);
    }
  }

  // -- canvas.wires --------------------------------------------------------
  if (!Array.isArray(canvas.wires)) {
    errors.push('canvas.wires must be an array');
  }

  // -- canvas.layout (optional) --------------------------------------------
  if (canvas.layout !== undefined) {
    if (canvas.layout == null || typeof canvas.layout !== 'object' || Array.isArray(canvas.layout)) {
      errors.push('canvas.layout must be an object if provided');
    } else {
      const layout = canvas.layout as Record<string, unknown>;
      if (typeof layout.algorithm !== 'string' || layout.algorithm.length === 0) {
        errors.push('canvas.layout.algorithm must be a non-empty string');
      }
    }
  }

  // -- agents (optional) ---------------------------------------------------
  if (bp.agents !== undefined) {
    if (!Array.isArray(bp.agents)) {
      errors.push('agents must be an array if provided');
    } else {
      for (let i = 0; i < bp.agents.length; i++) {
        validateAgentDef(bp.agents[i], i, agentRefIds, errors);
      }
    }
  }

  // -- projects (optional) -------------------------------------------------
  if (bp.projects !== undefined) {
    if (!Array.isArray(bp.projects)) {
      errors.push('projects must be an array if provided');
    } else {
      for (let i = 0; i < bp.projects.length; i++) {
        validateProjectRef(bp.projects[i], i, projectRefIds, errors);
      }
    }
  }

  // -- requiredPlugins (optional) ------------------------------------------
  if (bp.requiredPlugins !== undefined) {
    if (!Array.isArray(bp.requiredPlugins)) {
      errors.push('requiredPlugins must be an array if provided');
    } else {
      for (let i = 0; i < bp.requiredPlugins.length; i++) {
        if (typeof bp.requiredPlugins[i] !== 'string') {
          errors.push(`requiredPlugins[${i}] must be a string`);
        }
      }
    }
  }

  // -- cross-reference validation ------------------------------------------
  // Wire refs must point to existing view refIds
  if (Array.isArray(canvas.wires)) {
    for (let i = 0; i < canvas.wires.length; i++) {
      validateWire(canvas.wires[i], i, viewRefIds, errors);
    }
  }

  // View agentRef must point to existing agent refIds
  if (Array.isArray(canvas.views)) {
    for (let i = 0; i < canvas.views.length; i++) {
      const v = canvas.views[i];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const view = v as Record<string, unknown>;
        if (view.agentRef !== undefined) {
          if (typeof view.agentRef !== 'string') {
            errors.push(`canvas.views[${i}].agentRef must be a string`);
          } else if (!agentRefIds.has(view.agentRef)) {
            errors.push(`canvas.views[${i}].agentRef "${view.agentRef}" does not match any agent refId`);
          }
        }
        if (view.projectRef !== undefined) {
          if (typeof view.projectRef !== 'string') {
            errors.push(`canvas.views[${i}].projectRef must be a string`);
          } else if (!projectRefIds.has(view.projectRef)) {
            errors.push(`canvas.views[${i}].projectRef "${view.projectRef}" does not match any project refId`);
          }
        }
      }
    }
  }

  // Layout centerViewRef must point to existing view refId
  if (canvas.layout && typeof canvas.layout === 'object' && !Array.isArray(canvas.layout)) {
    const layout = canvas.layout as Record<string, unknown>;
    if (layout.centerViewRef !== undefined) {
      if (typeof layout.centerViewRef !== 'string') {
        errors.push('canvas.layout.centerViewRef must be a string');
      } else if (!viewRefIds.has(layout.centerViewRef)) {
        errors.push(`canvas.layout.centerViewRef "${layout.centerViewRef}" does not match any view refId`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function validateOptionalString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof obj[key] !== 'string') {
    errors.push(`${key} must be a string if provided`);
  }
}

function validateView(
  data: unknown,
  index: number,
  refIds: Set<string>,
  errors: string[],
): void {
  const prefix = `canvas.views[${index}]`;

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${prefix} must be a non-null object`);
    return;
  }

  const v = data as Record<string, unknown>;

  if (typeof v.refId !== 'string' || v.refId.length === 0) {
    errors.push(`${prefix}.refId must be a non-empty string`);
  } else if (refIds.has(v.refId)) {
    errors.push(`${prefix}.refId "${v.refId}" is a duplicate`);
  } else {
    refIds.add(v.refId);
  }

  if (typeof v.type !== 'string' || v.type.length === 0) {
    errors.push(`${prefix}.type must be a non-empty string`);
  }

  if (typeof v.displayName !== 'string' || v.displayName.length === 0) {
    errors.push(`${prefix}.displayName must be a non-empty string`);
  }

  // position
  if (v.position == null || typeof v.position !== 'object' || Array.isArray(v.position)) {
    errors.push(`${prefix}.position must be a {x, y} object`);
  } else {
    const pos = v.position as Record<string, unknown>;
    if (typeof pos.x !== 'number') errors.push(`${prefix}.position.x must be a number`);
    if (typeof pos.y !== 'number') errors.push(`${prefix}.position.y must be a number`);
  }

  // optional size
  if (v.size !== undefined) {
    if (v.size == null || typeof v.size !== 'object' || Array.isArray(v.size)) {
      errors.push(`${prefix}.size must be a {width, height} object if provided`);
    } else {
      const sz = v.size as Record<string, unknown>;
      if (typeof sz.width !== 'number') errors.push(`${prefix}.size.width must be a number`);
      if (typeof sz.height !== 'number') errors.push(`${prefix}.size.height must be a number`);
    }
  }
}

function validateWire(
  data: unknown,
  index: number,
  viewRefIds: Set<string>,
  errors: string[],
): void {
  const prefix = `canvas.wires[${index}]`;

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${prefix} must be a non-null object`);
    return;
  }

  const w = data as Record<string, unknown>;

  if (typeof w.sourceRef !== 'string' || w.sourceRef.length === 0) {
    errors.push(`${prefix}.sourceRef must be a non-empty string`);
  } else if (!viewRefIds.has(w.sourceRef)) {
    errors.push(`${prefix}.sourceRef "${w.sourceRef}" does not match any view refId`);
  }

  if (typeof w.targetRef !== 'string' || w.targetRef.length === 0) {
    errors.push(`${prefix}.targetRef must be a non-empty string`);
  } else if (!viewRefIds.has(w.targetRef)) {
    errors.push(`${prefix}.targetRef "${w.targetRef}" does not match any view refId`);
  }
}

function validateAgentDef(
  data: unknown,
  index: number,
  refIds: Set<string>,
  errors: string[],
): void {
  const prefix = `agents[${index}]`;

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${prefix} must be a non-null object`);
    return;
  }

  const a = data as Record<string, unknown>;

  if (typeof a.refId !== 'string' || a.refId.length === 0) {
    errors.push(`${prefix}.refId must be a non-empty string`);
  } else if (refIds.has(a.refId)) {
    errors.push(`${prefix}.refId "${a.refId}" is a duplicate`);
  } else {
    refIds.add(a.refId);
  }

  if (typeof a.name !== 'string' || a.name.length === 0) {
    errors.push(`${prefix}.name must be a non-empty string`);
  }
}

function validateProjectRef(
  data: unknown,
  index: number,
  refIds: Set<string>,
  errors: string[],
): void {
  const prefix = `projects[${index}]`;

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${prefix} must be a non-null object`);
    return;
  }

  const p = data as Record<string, unknown>;

  if (typeof p.refId !== 'string' || p.refId.length === 0) {
    errors.push(`${prefix}.refId must be a non-empty string`);
  } else if (refIds.has(p.refId)) {
    errors.push(`${prefix}.refId "${p.refId}" is a duplicate`);
  } else {
    refIds.add(p.refId);
  }

  if (typeof p.name !== 'string' || p.name.length === 0) {
    errors.push(`${prefix}.name must be a non-empty string`);
  }
}
