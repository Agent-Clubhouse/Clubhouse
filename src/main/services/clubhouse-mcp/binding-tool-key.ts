import { randomBytes } from 'crypto';
import type { McpBinding } from './types';

// Keys belong to the binding object, not mutable display metadata. Weak keys
// release removed bindings. A non-secret 128-bit process incarnation prevents
// stale client lists from resolving after a restart, even with reordered wires.
const MAX_GENERATION = 0xffff_ffff;
// clubhouse__ (11) + key (33) + __ (2) + check_connectivity (18) = 64.
// Only display text is shortened; all 128 incarnation bits and generation stay.
const KEY_BUDGET = 33;

/** One in-memory main-process namespace. It never persists counters or retired names. */
export class BindingToolKeyNamespace {
  private keys = new WeakMap<McpBinding, string>();

  constructor(private readonly incarnation: string, private generation = 0) {}

  initialize(binding: McpBinding): void {
    if (binding.targetKind !== 'agent' && binding.targetKind !== 'group-project') return;
    if (this.keys.has(binding)) return;
    // Fail closed rather than wrap/reuse a generation or truncate its identity.
    if (this.generation === MAX_GENERATION) throw new Error('MCP binding tool identity exhausted');
    const identity = `${this.incarnation}_${(++this.generation).toString(36)}`;
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const readable = binding.targetKind === 'agent'
      ? `${sanitizeId(binding.projectName || 'project').slice(0, 3)}_${name}`
      : name;
    const prefix = readable.slice(0, Math.max(0, KEY_BUDGET - identity.length - 1));
    this.keys.set(binding, prefix ? `${prefix}_${identity}` : identity);
  }

  get(binding: McpBinding): string | undefined {
    return this.keys.get(binding);
  }
}

// Entropy failure aborts initialization; it must never fall back to a reused namespace.
const incarnation = BigInt(`0x${randomBytes(16).toString('hex')}`).toString(36).padStart(25, '0');
const bindingToolKeys = new BindingToolKeyNamespace(incarnation);

/** Assign before a new binding is exposed to any listener or tool-list reader. */
export function initializeBindingToolKey(binding: McpBinding): void {
  bindingToolKeys.initialize(binding);
}

/** An actual wire keeps its key; an unbound descriptor only formats a display key. */
export function buildToolKey(binding: McpBinding): string {
  return bindingToolKeys.get(binding) ?? displayToolKey(binding);
}

/** Sanitize an ID for use in tool names (replace non-alphanumeric with underscores). */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/** A compact display discriminator (FNV-1a); managed wires use incarnation/generation. */
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
function displayToolKey(binding: McpBinding): string {
  if (binding.targetKind === 'agent') {
    const project = sanitizeId(binding.projectName || 'project');
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = shortHash(binding.targetId);
    return `${project}_${name}_${hash}`;
  }
  if (binding.targetKind === 'group-project') {
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = shortHash(binding.targetId);
    return `${name}_${hash}`;
  }
  return sanitizeId(binding.targetId);
}

