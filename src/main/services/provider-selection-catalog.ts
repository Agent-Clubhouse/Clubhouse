/** Pure current-catalog validation shared by per-agent provider selection.
 * No helper mappings, persistent catalog baselines or defaults are changed. */
import { createHash } from 'node:crypto';
import type { ModelList, OrchestratorProvider } from '../orchestrators/types';
import { MODEL_LIST_TTL_MS } from '../orchestrators/base-provider';
import { isEffortValue } from '../../shared/agent-helpers';

export function resolveProviderSelectionCatalog(list: ModelList | null, model: string | undefined, effort: string | null | undefined, requireModel: boolean, now = Date.now()) {
  const state = !list ? 'unavailable' : list.source !== 'live' || list.via !== 'handshake' || list.liveError ? 'fallback'
    : !Number.isFinite(list.fetchedAt) || list.fetchedAt < 0 || list.fetchedAt > now || now - list.fetchedAt > MODEL_LIST_TTL_MS ? 'stale' : 'current';
  const models = list?.models.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault ?? false, resolvedId: m.resolvedId ?? null, efforts: [...(m.efforts ?? [])], hidden: m.hidden ?? false })) ?? [];
  // Only a legacy stored alias with no concrete-model requirement means provider default.
  // Explicit wire selections are validated separately; effort still needs current catalog evidence.
  const selected = model === 'default' && !requireModel ? undefined : model;
  const base = selected?.replace(/\[1m\]$/i, '');
  const entry = !selected ? models.find((m) => m.isDefault)
    : models.find((m) => m.id === selected || m.id === base || m.resolvedId === base);
  const concrete = requireModel || typeof effort === 'string';
  const blocked = concrete && state !== 'current' ? `model_catalog_${state}`
    : requireModel && !entry ? 'model_not_offered'
      : typeof effort === 'string' && (!isEffortValue(effort) || !entry?.efforts.includes(effort)) ? 'effort_not_offered' : null;
  const catalog = { state, source: list?.source ?? null, via: list?.via ?? null, models };
  // Bind all offered semantics and error state; a refresh with identical
  // semantics does not invalidate confirmation solely because time advanced.
  const fingerprint = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return { catalog, fingerprint, blocked };
}

/** The provider's existing cached catalog is authoritative. A bounded read
 * never falls back to a static guessed selection or mutates helper presets. */
export async function readProviderSelectionCatalog(provider: OrchestratorProvider, model: string | undefined, effort: string | null | undefined, requireModel: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let list: ModelList | null = null;
  try {
    list = await Promise.race([
      provider.listModels?.() ?? Promise.resolve(null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); timer.unref?.(); }),
    ]);
  } catch { /* telemetry-exempt: unreadable catalogs are explicitly returned, never substituted. */ }
  finally { clearTimeout(timer); }
  return resolveProviderSelectionCatalog(list, model, effort, requireModel);
}
