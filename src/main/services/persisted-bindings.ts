/**
 * Persisted binding rebuild — restores MCP bindings from persisted stores when
 * the main process starts, so nothing waits on a renderer view to mount
 * (#1544).
 *
 * bindingManager is in-memory only. Anything that persists wires (the canvas
 * plugin today; orchestrated helpers, #2225, next) registers a
 * {@link PersistedBindingSource}. {@link rebuildPersistedBindings} asks every
 * source for its bindings and applies them through the same binding manager
 * the renderer's IPC path uses.
 *
 * Applying is idempotent: a binding that already exists (the renderer bound it
 * first, or a second rebuild runs) is left untouched, so a later canvas
 * hydrate can't double-create one and the rebuild never overwrites
 * instructions edited since. Sources only read their stores; this module never
 * writes them.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { bootstrapGroupProjectAdmin } from './group-project-admin-service';
import { appLog } from './log-service';

const VALID_TARGET_KINDS: ReadonlySet<string> = new Set<BindingTargetKind>([
  'browser', 'agent', 'terminal', 'group-project', 'plugin',
]);

/** A binding as a source persists it. */
export interface PersistedBinding {
  agentId: string;
  targetId: string;
  targetKind: BindingTargetKind;
  label: string;
  agentName?: string;
  targetName?: string;
  projectName?: string;
  instructions?: Record<string, string>;
  disabledTools?: string[];
}

/** Something that persists bindings and can list them at startup. */
export interface PersistedBindingSource {
  /** Stable id, used in logs and to replace a source registered twice. */
  id: string;
  /**
   * The bindings to restore. Read-only: must not write the source's store.
   * Stale entries (endpoints that no longer exist) should already be dropped.
   */
  collect(): Promise<PersistedBinding[]>;
}

export type ApplyOutcome = 'created' | 'existing' | 'invalid';

/** Per-source result of a rebuild. */
export interface SourceRebuildResult {
  id: string;
  collected: number;
  created: number;
  existing: number;
  invalid: number;
  error?: string;
}

export interface RebuildResult {
  sources: SourceRebuildResult[];
}

const sources = new Map<string, PersistedBindingSource>();
let inflight: Promise<RebuildResult> | null = null;

/**
 * Register a source. A source with the same id replaces the earlier one.
 * Returns a function that unregisters it.
 */
export function registerPersistedBindingSource(source: PersistedBindingSource): () => void {
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
}

/** Ids of the registered sources, in registration order. */
export function getPersistedBindingSourceIds(): string[] {
  return [...sources.keys()];
}

/**
 * Create one persisted binding if it does not exist yet, with its
 * instructions and disabled tools. An existing binding is left as it is.
 */
export function applyPersistedBinding(binding: PersistedBinding): ApplyOutcome {
  if (!binding || !binding.agentId || !binding.targetId || !binding.label || !VALID_TARGET_KINDS.has(binding.targetKind)) {
    return 'invalid';
  }
  const created = bindingManager.bind(binding.agentId, {
    targetId: binding.targetId,
    targetKind: binding.targetKind,
    label: binding.label,
    agentName: binding.agentName,
    targetName: binding.targetName,
    projectName: binding.projectName,
  });
  if (!created) return 'existing';
  if (binding.instructions && Object.keys(binding.instructions).length > 0) {
    bindingManager.setInstructions(binding.agentId, binding.targetId, binding.instructions);
  }
  if (binding.disabledTools && binding.disabledTools.length > 0) {
    bindingManager.setDisabledTools(binding.agentId, binding.targetId, binding.disabledTools);
  }
  if (binding.targetKind === 'group-project') {
    // Same as the renderer's bind IPC: the first member becomes the lead.
    void bootstrapGroupProjectAdmin(binding.targetId, binding.agentId).catch((): void => undefined);
  }
  return 'created';
}

async function rebuildSource(source: PersistedBindingSource): Promise<SourceRebuildResult> {
  const result: SourceRebuildResult = { id: source.id, collected: 0, created: 0, existing: 0, invalid: 0 };
  let bindings: PersistedBinding[];
  try {
    bindings = await source.collect();
  } catch (err) {
    // telemetry-exempt: logged and returned in the rebuild result
    result.error = err instanceof Error ? err.message : String(err);
    appLog('core:mcp', 'warn', 'Persisted binding source failed; its bindings wait for the renderer', {
      meta: { source: source.id, error: result.error },
    });
    return result;
  }
  result.collected = bindings.length;
  for (const binding of bindings) {
    const outcome = applyPersistedBinding(binding);
    result[outcome]++;
  }
  return result;
}

/**
 * Rebuild bindings from every registered source. Safe to call more than once;
 * concurrent calls share one run.
 */
export function rebuildPersistedBindings(): Promise<RebuildResult> {
  if (inflight) return inflight;
  inflight = (async () => {
    const results: SourceRebuildResult[] = [];
    for (const source of [...sources.values()]) {
      results.push(await rebuildSource(source));
    }
    appLog('core:mcp', 'info', 'Persisted bindings rebuilt', {
      meta: { sources: results },
    });
    return { sources: results };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** For testing: drop every registered source. */
export function _resetPersistedBindingSourcesForTesting(): void {
  sources.clear();
  inflight = null;
}
