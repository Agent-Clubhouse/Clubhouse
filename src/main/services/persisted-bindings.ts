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
 * first, or a second rebuild runs) is not created again, so a later canvas
 * hydrate can't double-create one and the rebuild never overwrites
 * instructions edited since. A pruning source derives its labels from live
 * state, so when it lists a binding that already exists under an old label (a
 * renamed project, #2561) the label fields are updated in place
 * ({@link relabelBinding}); the wire stays up. Sources only read their stores; this module never
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
 * it or the user drew it since (a BIND, which zone wires send too). Bindings a
 * pruning source found already there are never its to remove. While such a
 * source lists a pair, canvas cleanup (closing a card or a canvas tab, a zone
 * member leaving) does not unbind it: {@link keepHeldBinding} hands the pair to
 * the source instead.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { appLog } from './log-service';

/** 'plugin' is left out (#2082): no source persists plugin wires, and one that does is skipped. */
const VALID_TARGET_KINDS: ReadonlySet<string> = new Set<BindingTargetKind>([
  'browser', 'agent', 'terminal', 'group-project',
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
   * The bindings to restore. Read-only: must not change the source's
   * entries. The one exception is housekeeping that loses nothing: a store
   * file that can't be parsed may be moved aside (kept, renamed) so it is
   * read as empty, as orchestrator-connections does.
   * Stale entries (endpoints that no longer exist) should already be dropped.
   */
  collect(): Promise<PersistedBinding[] | CollectedBindings>;
  /**
   * Remove a binding this source created once it no longer lists it. Skipped
   * for a pair another source lists, for a pair the user drew or removed
   * since, for a pair the source could not check this run, and for any run in
   * which a source failed to collect.
   */
  prune?: boolean;
  /**
   * Called after each rebuild. `complete` is false when any source failed to
   * collect, so the bindings may not match what this source listed.
   */
  afterRebuild?(complete: boolean): void;
}

/** A collect that could only check part of its store. */
export interface CollectedBindings {
  bindings: PersistedBinding[];
  /**
   * Pairs the source could not check this run (e.g. one project's config was
   * unreadable). They are neither applied nor pruned, and still count as held.
   */
  unverified?: Array<{ agentId: string; targetId: string }>;
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
/** Pruning source id → the pairs it listed (or could not check) on its last successful collect. */
const heldBySource = new Map<string, Set<string>>();
/**
 * Pruning source id → pairs claimed ({@link claimSourceBinding}) since the
 * running rebuild started. That run's collect may predate the claim, so it
 * neither prunes them nor drops them from the source's held pairs.
 */
const claimedDuringRun = new Map<string, Set<string>>();

/** The pairs a pruning source owns, created on first use. */
function ownedFor(sourceId: string): Map<string, { agentId: string; targetId: string }> {
  let owned = ownedBySource.get(sourceId);
  if (!owned) {
    owned = new Map();
    ownedBySource.set(sourceId, owned);
  }
  return owned;
}

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
  for (const listener of [...removedByUserListeners]) {
    try {
      listener(agentId, targetId);
    } catch (err) {
      // telemetry-exempt: logged; one listener failing must not stop the removal or the others
      appLog('core:mcp', 'warn', 'User-removal listener failed', {
        meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

export type BindingRemovedByUserListener = (agentId: string, targetId: string) => void;
const removedByUserListeners = new Set<BindingRemovedByUserListener>();

/**
 * Listen for the user removing a pair through the renderer, so a source that
 * stores the pair itself can drop it and keep it removed across restarts
 * (orchestrator connections, #2230). Returns an unsubscribe function.
 */
export function onBindingRemovedByUser(listener: BindingRemovedByUserListener): () => void {
  removedByUserListeners.add(listener);
  return () => { removedByUserListeners.delete(listener); };
}

/** True when the user removed this pair through the renderer this session. */
export function isBindingRemovedByUser(agentId: string, targetId: string): boolean {
  return removedByUser.has(pairKey(agentId, targetId));
}

/** The user drew this wire (renderer bind): rebuilds may restore it again. */
export function clearBindingRemovedByUser(agentId: string, targetId: string): void {
  removedByUser.delete(pairKey(agentId, targetId));
  releaseOwnership(pairKey(agentId, targetId));
  for (const listener of [...drawnByUserListeners]) {
    try {
      listener(agentId, targetId);
    } catch (err) {
      // telemetry-exempt: logged; one listener failing must not stop the bind or the others
      appLog('core:mcp', 'warn', 'User-draw listener failed', {
        meta: { agentId, targetId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

const drawnByUserListeners = new Set<BindingRemovedByUserListener>();

/**
 * Listen for the user drawing a pair through the renderer, so a source that
 * remembers a removal across restarts (Dispatcher connections, #2661) can
 * forget it. Returns an unsubscribe function.
 */
export function onBindingDrawnByUser(listener: BindingRemovedByUserListener): () => void {
  drawnByUserListeners.add(listener);
  return () => { drawnByUserListeners.delete(listener); };
}

/**
 * Canvas cleanup wants to unbind this pair (a card or canvas tab closed, a
 * zone member left), not the user deleting the wire. When a pruning source
 * still lists the pair and main holds the binding (not removed by the user),
 * returns true and makes the binding that source's, so
 * it stays while the source lists it and goes when it stops. Otherwise false:
 * unbind as usual.
 */
export function keepHeldBinding(agentId: string, targetId: string): boolean {
  const key = pairKey(agentId, targetId);
  // Only a binding main actually holds can be kept, and never one the user removed.
  if (removedByUser.has(key)) return false;
  if (!bindingManager.getBindingsForAgent(agentId).some((b) => b.targetId === targetId)) return false;
  let held = false;
  for (const [sourceId, pairs] of heldBySource) {
    if (!pairs.has(key) || !sources.get(sourceId)?.prune) continue;
    held = true;
    let owned = ownedBySource.get(sourceId);
    if (!owned) {
      owned = new Map();
      ownedBySource.set(sourceId, owned);
    }
    owned.set(key, { agentId, targetId });
  }
  return held;
}

/**
 * The pairs `sourceId` created and still owns, that no other pruning source
 * lists (#2232). A pair a canvas, a zone, the user or another source made, or
 * also lists, is not here: removing it is not only that source's business.
 */
export function listSoleOwnedPairs(sourceId: string): Array<{ agentId: string; targetId: string }> {
  const owned = ownedBySource.get(sourceId);
  if (!owned) return [];
  const out: Array<{ agentId: string; targetId: string }> = [];
  for (const [key, pair] of owned) {
    if (removedByUser.has(key)) continue;
    let heldElsewhere = false;
    for (const [otherId, pairs] of heldBySource) {
      if (otherId !== sourceId && pairs.has(key)) { heldElsewhere = true; break; }
    }
    if (!heldElsewhere) out.push({ ...pair });
  }
  return out;
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
 * Stable description of one binding for a source's change check: the pair and
 * its label fields, so a rename (a new label, same pair) counts as a change
 * and the rebuild that follows relabels the live binding (#2561).
 */
export function bindingSignature(binding: PersistedBinding): string {
  const { agentId, targetId, label, agentName, targetName, projectName } = binding;
  return [agentId, targetId, label, agentName ?? '', targetName ?? '', projectName ?? ''].join('\u0000');
}

/**
 * Bring an existing binding's label fields up to date with `binding` (a
 * renamed project or agent, #2561). Updated in place, never unbound and bound
 * again, so a live wire doesn't drop; a change refreshes the agent's tool
 * list through the binding manager's change listeners.
 */
function relabelBinding(binding: PersistedBinding): void {
  bindingManager.updateBinding(binding.agentId, binding.targetId, {
    label: binding.label,
    agentName: binding.agentName,
    targetName: binding.targetName,
    projectName: binding.projectName,
  });
}

/**
 * Create one persisted binding if it does not exist yet, with its
 * instructions and disabled tools. An existing binding keeps its instructions
 * and disabled tools; with `relabel` its label fields are brought up to date.
 */
export function applyPersistedBinding(binding: PersistedBinding, options: { relabel?: boolean } = {}): ApplyOutcome {
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
    if (options.relabel) relabelBinding(binding);
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

/**
 * Bind a pair on behalf of a pruning source, as an explicit act rather than a
 * restore (an orchestrator's connection tool, #2230): the group-project
 * lifecycle treats it like a wire the user drew, with the usual join
 * bulletin. The caller has already written the pair to the source's store.
 *
 * Follows the #2246 ownership rules: the source owns the binding only when
 * this call created it, so a binding a canvas wire, zone or another source
 * made first is never the source's to remove. A pair the user removed this
 * session is not bound ('removed'): only the user can draw it again. A pair
 * already bound keeps its binding, with its label fields updated ('existing').
 */
export function claimSourceBinding(sourceId: string, binding: PersistedBinding): 'created' | 'existing' | 'removed' | 'invalid' {
  if (!binding || !binding.agentId || !binding.targetId || !binding.label || !VALID_TARGET_KINDS.has(binding.targetKind)) {
    return 'invalid';
  }
  const key = pairKey(binding.agentId, binding.targetId);
  if (removedByUser.has(key)) return 'removed';
  const source = sources.get(sourceId);
  if (source?.prune) {
    let held = heldBySource.get(sourceId);
    if (!held) {
      held = new Set();
      heldBySource.set(sourceId, held);
    }
    held.add(key);
    let claimed = claimedDuringRun.get(sourceId);
    if (!claimed) {
      claimed = new Set();
      claimedDuringRun.set(sourceId, claimed);
    }
    claimed.add(key);
  }
  const alreadyBound = bindingManager.getBindingsForAgent(binding.agentId).some((b) => b.targetId === binding.targetId);
  if (alreadyBound) {
    relabelBinding(binding);
    return 'existing';
  }
  // Not a restore: the lifecycle must announce this join. Only cleared for a
  // pair that is not bound, so a restore whose join is still pending stays silent.
  restoredPairs.delete(key);
  bindingManager.bind(binding.agentId, {
    targetId: binding.targetId,
    targetKind: binding.targetKind,
    label: binding.label,
    agentName: binding.agentName,
    targetName: binding.targetName,
    projectName: binding.projectName,
  });
  if (source?.prune) ownedFor(sourceId).set(key, { agentId: binding.agentId, targetId: binding.targetId });
  return 'created';
}

/**
 * A pruning source dropped a pair from its store (an orchestrator's
 * disconnect, #2230): remove the binding now if the source owns it. A binding
 * another pruning source still lists stays and becomes that source's; one the
 * source does not own (a canvas wire, a zone, a wire the user drew) stays.
 * Returns what happened to the live binding.
 */
export function releaseSourceBinding(sourceId: string, agentId: string, targetId: string): 'unbound' | 'kept' | 'absent' {
  const key = pairKey(agentId, targetId);
  heldBySource.get(sourceId)?.delete(key);
  claimedDuringRun.get(sourceId)?.delete(key);
  const bound = bindingManager.getBindingsForAgent(agentId).some((b) => b.targetId === targetId);
  const owned = ownedBySource.get(sourceId);
  if (!owned?.delete(key)) return bound ? 'kept' : 'absent';
  if (!bound) return 'absent';
  let heldElsewhere = false;
  for (const [otherId, pairs] of heldBySource) {
    if (otherId === sourceId || !pairs.has(key) || !sources.get(otherId)?.prune) continue;
    heldElsewhere = true;
    ownedFor(otherId).set(key, { agentId, targetId });
  }
  if (heldElsewhere) return 'kept';
  restoredPairs.delete(key);
  bindingManager.unbind(agentId, targetId);
  return 'unbound';
}

interface SourceRun {
  source: PersistedBindingSource;
  result: SourceRebuildResult;
  /** Pairs the source listed this run; null when its collect failed. */
  listed: Set<string> | null;
  /** Pairs the source could not check this run. */
  unverified: Set<string>;
}

async function rebuildSource(source: PersistedBindingSource): Promise<SourceRun> {
  const result: SourceRebuildResult = { id: source.id, collected: 0, created: 0, existing: 0, removed: 0, invalid: 0 };
  if (source.prune) result.pruned = 0;
  let bindings: PersistedBinding[];
  const unverified = new Set<string>();
  try {
    const collected = await source.collect();
    if (Array.isArray(collected)) {
      bindings = collected;
    } else {
      bindings = collected.bindings;
      for (const pair of collected.unverified ?? []) unverified.add(pairKey(pair.agentId, pair.targetId));
    }
  } catch (err) {
    // telemetry-exempt: logged and returned in the rebuild result
    result.error = err instanceof Error ? err.message : String(err);
    appLog('core:mcp', 'warn', 'Persisted binding source failed; its bindings wait for the renderer', {
      meta: { source: source.id, error: result.error },
    });
    return { source, result, listed: null, unverified };
  }
  result.collected = bindings.length;
  const listed = new Set<string>();
  let owned = ownedBySource.get(source.id);
  if (source.prune && !owned) {
    owned = new Map();
    ownedBySource.set(source.id, owned);
  }
  for (const binding of bindings) {
    // Pruning sources derive labels from live state: theirs are current.
    const outcome = applyPersistedBinding(binding, { relabel: source.prune });
    result[outcome]++;
    if (outcome === 'invalid') continue;
    const key = pairKey(binding.agentId, binding.targetId);
    listed.add(key);
    if (outcome === 'created' && owned) owned.set(key, { agentId: binding.agentId, targetId: binding.targetId });
  }
  if (source.prune) {
    heldBySource.set(source.id, new Set([...listed, ...unverified, ...(claimedDuringRun.get(source.id) ?? [])]));
  }
  return { source, result, listed, unverified };
}

/**
 * Remove the bindings pruning sources created and no longer list. Nothing is
 * removed in a run where any source failed: its pairs are unknown.
 */
function pruneRuns(runs: SourceRun[]): void {
  if (runs.some((run) => run.listed === null)) return;
  /** Pairs a source lists, could not check, or (pruning sources) claimed since this run started. */
  const holds = (run: SourceRun, key: string): boolean =>
    run.listed!.has(key) || run.unverified.has(key) || (!!run.source.prune && !!claimedDuringRun.get(run.source.id)?.has(key));
  const listedAnywhere = new Set<string>();
  for (const run of runs) {
    for (const key of [...run.listed!, ...run.unverified]) listedAnywhere.add(key);
    if (run.source.prune) for (const key of claimedDuringRun.get(run.source.id) ?? []) listedAnywhere.add(key);
  }
  for (const run of runs) {
    if (!run.source.prune) continue;
    const owned = ownedBySource.get(run.source.id);
    if (!owned) continue;
    for (const [key, pair] of owned) {
      if (holds(run, key)) continue;
      owned.delete(key);
      // Another source lists it: that wire keeps the binding. A pruning
      // source that lists it takes ownership, so it can remove the binding
      // once it stops listing it too.
      if (listedAnywhere.has(key)) {
        for (const other of runs) {
          if (other === run || !other.source.prune || !holds(other, key)) continue;
          ownedFor(other.source.id).set(key, pair);
        }
        continue;
      }
      restoredPairs.delete(key);
      if (bindingManager.getBindingsForAgent(pair.agentId).some((b) => b.targetId === pair.targetId)) {
        bindingManager.unbind(pair.agentId, pair.targetId);
        run.result.pruned = (run.result.pruned ?? 0) + 1;
      }
    }
  }
}

async function runRebuild(): Promise<RebuildResult> {
  // Claims made before this run are in the stores it is about to read.
  claimedDuringRun.clear();
  const runs: SourceRun[] = [];
  for (const source of [...sources.values()]) {
    runs.push(await rebuildSource(source));
  }
  pruneRuns(runs);
  const complete = runs.every((run) => run.listed !== null);
  for (const run of runs) {
    try {
      run.source.afterRebuild?.(complete);
    } catch (err) {
      // telemetry-exempt: logged; one source's hook must not fail the rebuild
      appLog('core:mcp', 'warn', 'Persisted binding source afterRebuild failed', {
        meta: { source: run.source.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
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
  heldBySource.clear();
  claimedDuringRun.clear();
  removedByUser.clear();
}
