import type { McpBinding } from './types';

// Keys belong to the binding object, not its mutable display metadata. Weak keys
// release removed bindings; a single generation counter avoids retired-name tombstones.
const bindingToolKeys = new WeakMap<McpBinding, string>();
let generation = 0n;

/** Assign once when an agent/group wire is created, before listeners see it. */
export function initializeBindingToolKey(binding: McpBinding): void {
  if (binding.targetKind !== 'agent' && binding.targetKind !== 'group-project') return;
  if (bindingToolKeys.has(binding)) return;
  bindingToolKeys.set(binding, displayToolKey(binding, `b${(++generation).toString(36)}`));
}

/** An actual wire keeps its key; an unbound descriptor only formats a display key. */
export function buildToolKey(binding: McpBinding): string {
  return bindingToolKeys.get(binding) ?? displayToolKey(binding);
}

/** Sanitize an ID for use in tool names (replace non-alphanumeric with underscores). */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/** A compact display discriminator (FNV-1a); binding generations ensure uniqueness. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0).toString(36).padStart(4, '0').slice(0, 4);
}

/**
 * Build a tool key (the middle segment of a tool name) from a binding.
 * For agent targets: `<project>_<targetName>_<hash>`
 * For other targets: sanitized targetId.
 */
function displayToolKey(binding: McpBinding, identity?: string): string {
  if (binding.targetKind === 'agent') {
    const project = sanitizeId(binding.projectName || 'project');
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = identity ?? shortHash(binding.targetId);
    return `${project}_${name}_${hash}`;
  }
  if (binding.targetKind === 'group-project') {
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = identity ?? shortHash(binding.targetId);
    return `${name}_${hash}`;
  }
  return sanitizeId(binding.targetId);
}

