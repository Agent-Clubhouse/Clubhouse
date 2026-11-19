/** Pure current-catalog validation shared by per-agent provider selection.
 * No helper mappings, persistent catalog baselines or defaults are changed. */
import { createHash } from 'node:crypto';
import type { ModelList, OrchestratorProvider } from '../orchestrators/types';
import { MODEL_LIST_TTL_MS } from '../orchestrators/base-provider';
import { isEffortValue } from '../../shared/agent-helpers';

export function resolveProviderSelectionCatalog(list: ModelList | null, model: string | undefined, effort: string | null | undefined, requireModel: boolean, now = Date.now(), policy?: Pick<OrchestratorProvider, 'id' | 'acceptsModel'>) {
  const state = !list ? 'unavailable' : list.source !== 'live' || list.via !== 'handshake' || list.liveError ? 'fallback'
    : !Number.isFinite(list.fetchedAt) || list.fetchedAt < 0 || list.fetchedAt > now || now - list.fetchedAt > MODEL_LIST_TTL_MS ? 'stale' : 'current';
  const models = list?.models.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault ?? false, resolvedId: m.resolvedId ?? null, efforts: [...(m.efforts ?? [])], hidden: m.hidden ?? false })) ?? [];
  // Only a legacy stored alias with no concrete-model requirement means provider default.
  // Explicit wire selections are validated separately; effort still needs current catalog evidence.
  const selected = model === 'default' && !requireModel ? undefined : model;
  let matches = !selected ? models.filter((m) => m.isDefault) : models.filter((m) => m.id === selected);
  let matchedBy = !selected ? 'provider_default' : 'catalog_id';
  if (selected && !matches.length) { matches = models.filter((m) => m.resolvedId === selected); matchedBy = 'catalog_resolved_id'; }
  let aliasUnverified = false;
  if (selected && !matches.length && state === 'current' && policy?.id === 'claude-code' && policy.acceptsModel && list) {
    let authorized = false;
    try { authorized = policy.acceptsModel(selected, list); }
    catch { aliasUnverified = true; /* telemetry-exempt: an unverified alias is refused, never substituted. */ }
    if (authorized) {
      // Claude is the only existing non-exact policy with a proven catalog
      // mapping. Its predicate must authorize the unchanged requested string.
      // Other/custom providers need a separately reviewed alias mapping.
      const base = selected.replace(/\[1m\]$/i, '').toLowerCase();
      matches = models.filter((m) => m.id.toLowerCase() === base);
      if (!matches.length) matches = models.filter((m) => m.resolvedId?.toLowerCase() === base);
      matchedBy = 'provider_policy';
    }
  }
  // Policy-only family aliases with no unique current entry cannot borrow
  // another model's effort schema. Ambiguous catalog aliases fail closed.
  const entry = matches.length === 1 ? matches[0] : undefined;
  const resolution = { entryId: entry?.id ?? null, matchedBy: entry ? matchedBy : null, policy: entry && matchedBy === 'provider_policy' ? policy?.id ?? null : null, aliasUnverified };
  const concrete = requireModel || typeof effort === 'string';
  const blocked = concrete && state !== 'current' ? `model_catalog_${state}`
    : aliasUnverified ? 'model_alias_unverified' : requireModel && !entry ? 'model_not_offered'
      : typeof effort === 'string' && (!isEffortValue(effort) || !entry?.efforts.includes(effort)) ? 'effort_not_offered' : null;
  const catalog = { state, source: list?.source ?? null, via: list?.via ?? null, models };
  // Bind all offered semantics and error state; a refresh with identical
  // semantics does not invalidate confirmation solely because time advanced.
  const fingerprint = createHash('sha256').update(JSON.stringify({ catalog, resolution })).digest('hex');
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
  return resolveProviderSelectionCatalog(list, model, effort, requireModel, undefined, provider);
}
