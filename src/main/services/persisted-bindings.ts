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
 *
 * A restore is silent: it brings back tools and wires only. Each binding it
 * creates is recorded so the group-project lifecycle can tell a membership
 * that existed before this launch from one the user just drew, and skip the
 * join bulletin, polling start and lead bootstrap for it
 * ({@link consumeRestoredBinding}).
 *
 * The rebuild runs again when MCP settings or Clubhouse Mode change. A wire
 * the user removed this session may still be in a store whose save hasn't
 * landed (or is blocked), so pairs removed through the renderer are skipped
 * until the user draws them again ({@link markBindingRemovedByUser}).
 *
 * A source that derives its wires from live state (helpers, #2225: the agent
 * config's `parentAgentId`) sets `prune`. A binding such a source created is
 * removed once the source stops listing it, unless another source still lists
 * it or the user drew it since. Bindings a pruning source found already there
 * are never its to remove.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import type { BindingTargetKind } from './clubhouse-mcp/types';
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
  /**
   * Remove a binding this source created once it no longer lists it. Skipped
   * for a pair another source lists, for a pair the user drew or removed
   * since, and for any run in which a source failed to collect.
   */
  prune?: boolean;
}

export type ApplyOutcome = 'created' | 'existing' | 'removed' | 'invalid';

/** Per-source result of a rebuild. */
export interface SourceRebuildResult {
  id: string;
  collected: number;
  created: number;
  existing: number;
  /** Skipped: the user removed the pair earlier this session. */
  removed: number;
  invalid: number;
  /** Bindings removed because the source stopped listing them (pruning sources only). */
  pruned?: number;
  error?: string;
}

export interface RebuildResult {
  sources: SourceRebuildResult[];
}

const sources = new Map<string, PersistedBindingSource>();
let inflight: Promise<RebuildResult> | null = null;
/** A rebuild requested while one was running: runs once that one finishes. */
let queued: Promise<RebuildResult> | null = null;

const pairKey = (agentId: string, targetId: string): string => `${agentId}\u0000${targetId}`;
/** Bindings created by a restore whose membership side effects are still to be skipped. */
const restoredPairs = new Set<string>();
/** Pairs the user removed through the renderer this session. */
const removedByUser = new Set<string>();
/** Pruning source id → the pairs it created and may remove again. */
const ownedBySource = new Map<string, Map<string, { agentId: string; targetId: string }>>();

/** The user drew or removed this pair: no pruning source may remove it now. */
function releaseOwnership(key: string): void {
  for (const owned of ownedBySource.values()) owned.delete(key);
}

/**
 * True (once) when this binding was created by a restore rather than drawn by
 * the user. The group-project lifecycle calls it on join to stay silent; a
 * later rejoin of the same pair announces as usual.
 */
export function consumeRestoredBinding(agentId: string, targetId: string): boolean {
  return restoredPairs.delete(pairKey(agentId, targetId));
}

/** The user removed this wire (renderer unbind): later rebuilds skip it. */
export function markBindingRemovedByUser(agentId: string, targetId: string): void {
  removedByUser.add(pairKey(agentId, targetId));
  restoredPairs.delete(pairKey(agentId, targetId));
  releaseOwnership(pairKey(agentId, targetId));
}

/** The user drew this wire (renderer bind): rebuilds may restore it again. */
export function clearBindingRemovedByUser(agentId: string, targetId: string): void {
  removedByUser.delete(pairKey(agentId, targetId));
  releaseOwnership(pairKey(agentId, targetId));
}

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
  const key = pairKey(binding.agentId, binding.targetId);
  if (removedByUser.has(key)) return 'removed';
  // Recorded before bind: bind notifies listeners synchronously.
  const alreadyRestored = restoredPairs.has(key);
  restoredPairs.add(key);
  const created = bindingManager.bind(binding.agentId, {
    targetId: binding.targetId,
    targetKind: binding.targetKind,
    label: binding.label,
    agentName: binding.agentName,
    targetName: binding.targetName,
    projectName: binding.projectName,
  });
  if (!created) {
    if (!alreadyRestored) restoredPairs.delete(key);
    return 'existing';
  }
  if (binding.instructions && Object.keys(binding.instructions).length > 0) {
    bindingManager.setInstructions(binding.agentId, binding.targetId, binding.instructions);
  }
  if (binding.disabledTools && binding.disabledTools.length > 0) {
    bindingManager.setDisabledTools(binding.agentId, binding.targetId, binding.disabledTools);
  }
  return 'created';
}

interface SourceRun {
  source: PersistedBindingSource;
  result: SourceRebuildResult;
  /** Pairs the source listed this run; null when its collect failed. */
  listed: Set<string> | null;
}

async function rebuildSource(source: PersistedBindingSource): Promise<SourceRun> {
  const result: SourceRebuildResult = { id: source.id, collected: 0, created: 0, existing: 0, removed: 0, invalid: 0 };
  if (source.prune) result.pruned = 0;
  let bindings: PersistedBinding[];
  try {
    bindings = await source.collect();
  } catch (err) {
    // telemetry-exempt: logged and returned in the rebuild result
    result.error = err instanceof Error ? err.message : String(err);
    appLog('core:mcp', 'warn', 'Persisted binding source failed; its bindings wait for the renderer', {
      meta: { source: source.id, error: result.error },
    });
    return { source, result, listed: null };
  }
  result.collected = bindings.length;
  const listed = new Set<string>();
  let owned = ownedBySource.get(source.id);
  if (source.prune && !owned) {
    owned = new Map();
    ownedBySource.set(source.id, owned);
  }
  for (const binding of bindings) {
    const outcome = applyPersistedBinding(binding);
    result[outcome]++;
    if (outcome === 'invalid') continue;
    const key = pairKey(binding.agentId, binding.targetId);
    listed.add(key);
    if (outcome === 'created' && owned) owned.set(key, { agentId: binding.agentId, targetId: binding.targetId });
  }
  return { source, result, listed };
}

/**
 * Remove the bindings pruning sources created and no longer list. Nothing is
 * removed in a run where any source failed: its pairs are unknown.
 */
function pruneRuns(runs: SourceRun[]): void {
  if (runs.some((run) => run.listed === null)) return;
  const listedAnywhere = new Set<string>();
  for (const run of runs) for (const key of run.listed!) listedAnywhere.add(key);
  for (const run of runs) {
    if (!run.source.prune) continue;
    const owned = ownedBySource.get(run.source.id);
    if (!owned) continue;
    for (const [key, pair] of owned) {
      if (run.listed!.has(key)) continue;
      owned.delete(key);
      // Another source lists it: that wire keeps the binding.
      if (listedAnywhere.has(key)) continue;
      restoredPairs.delete(key);
      if (bindingManager.getBindingsForAgent(pair.agentId).some((b) => b.targetId === pair.targetId)) {
        bindingManager.unbind(pair.agentId, pair.targetId);
        run.result.pruned = (run.result.pruned ?? 0) + 1;
      }
    }
  }
}

async function runRebuild(): Promise<RebuildResult> {
  const runs: SourceRun[] = [];
  for (const source of [...sources.values()]) {
    runs.push(await rebuildSource(source));
  }
  pruneRuns(runs);
  const results = runs.map((run) => run.result);
  appLog('core:mcp', 'info', 'Persisted bindings rebuilt', {
    meta: { sources: results },
  });
  return { sources: results };
}

/**
 * Rebuild bindings from every registered source. Safe to call more than once.
 * A call made while a rebuild is running gets one follow-up run after it, so a
 * change that landed mid-run is not missed; further calls share that run.
 */
export function rebuildPersistedBindings(): Promise<RebuildResult> {
  if (!inflight) {
    inflight = runRebuild().finally(() => {
      inflight = null;
    });
    return inflight;
  }
  if (!queued) {
    queued = inflight.catch((): void => undefined).then((): Promise<RebuildResult> => {
      queued = null;
      return rebuildPersistedBindings();
    });
  }
  return queued;
}

/** For testing: drop every registered source. */
export function _resetPersistedBindingSourcesForTesting(): void {
  sources.clear();
  inflight = null;
  queued = null;
  restoredPairs.clear();
  ownedBySource.clear();
  removedByUser.clear();
}
