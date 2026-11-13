import { AUTO_LEVELS, BUILTIN_PRESETS, isPresetModel, isPresetProvider } from '../../shared/helper-routing';
import type { HelperCalibrationIdentityReason } from '../../shared/telemetry/helper-usage-contract';
import { IPC } from '../../shared/ipc-channels';
import type { ModelInfo, ModelList, OrchestratorProvider } from '../orchestrators/types';
import { isClaudeModelAlias } from '../orchestrators/claude-model-aliases';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { appLog } from './log-service';
import { getPresets } from './orchestration-settings';
import { getSettings as getOrchestratorSettings } from './orchestrator-settings';
import { createSettingsStore } from './settings-store';

interface CatalogSnapshot {
  at: number;
  models: Record<string, Pick<ModelInfo, 'label' | 'resolvedId'>>;
  seen: string[];
  missingNotified: string[];
}

interface CatalogFile {
  version: 1;
  providers: Record<string, CatalogSnapshot>;
}

const MAX_CATALOG_BYTES = 1024 * 1024;
export const HELPER_CALIBRATION_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
const latestCatalogs = new Map<string, { list: ModelList; newestLiveAt: number }>();

/** Evidence from reads already made by mapping validation, never another CLI call. */
export function peekHelperCalibrationModel(provider: string, model: string, now: number): { model?: string; reason: HelperCalibrationIdentityReason } {
  const evidence = latestCatalogs.get(provider);
  if (!evidence) return { reason: 'missing_catalog' };
  const { list } = evidence;
  if (list.source !== 'live' || list.liveError) return { reason: 'fallback_catalog' };
  if (!Number.isFinite(now) || !Number.isFinite(list.fetchedAt) || list.fetchedAt < evidence.newestLiveAt
    || list.fetchedAt < 0 || list.fetchedAt > now || now - list.fetchedAt > HELPER_CALIBRATION_CATALOG_MAX_AGE_MS) return { reason: 'stale_catalog' };
  const base = model.replace(/\[1m\]$/i, '');
  const entry = list.models.find((m) => m.id === model || m.id === base || m.resolvedId === base);
  const canonical = entry?.resolvedId ?? entry?.id;
  if (!isPresetModel(canonical) || isClaudeModelAlias(canonical)
    || canonical.replace(/\[1m\]$/i, '').toLowerCase() === 'auto') return { reason: 'unresolved_model' };
  return { model: canonical, reason: 'cached_catalog' };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

const store = createSettingsStore<CatalogFile>('helper-model-catalogs.json', { version: 1, providers: {} }, (raw) => {
  const providers: CatalogFile['providers'] = {};
  if (raw.version === 1 && raw.providers && typeof raw.providers === 'object') {
    for (const [id, value] of Object.entries(raw.providers)) {
      if (!value || typeof value !== 'object') continue;
      const snapshot = value as Partial<CatalogSnapshot>;
      if (typeof snapshot.at !== 'number' || !Number.isFinite(snapshot.at)
        || !snapshot.models || typeof snapshot.models !== 'object' || Array.isArray(snapshot.models)
        || !Object.values(snapshot.models).every((v) => v && typeof v === 'object' && typeof v.label === 'string'
          && (v.resolvedId === undefined || typeof v.resolvedId === 'string'))
        || !strings(snapshot.seen) || !strings(snapshot.missingNotified)) continue;
      providers[id] = snapshot as CatalogSnapshot;
    }
  }
  return { version: 1, providers };
}, { atomic: true, rollBackFailedSaves: true });

/** Observe existing token-free reads only. Failed, empty and fallback reads are not baselines. */
export async function observeHelperModelCatalog(provider: OrchestratorProvider, list: ModelList): Promise<void> {
  if (isPresetProvider(provider.id)) {
    const liveAt = list.source === 'live' && !list.liveError && Number.isFinite(list.fetchedAt) ? list.fetchedAt : 0;
    latestCatalogs.set(provider.id, {
      list: { ...list, models: list.models.map((m) => ({ ...m })) },
      newestLiveAt: Math.max(latestCatalogs.get(provider.id)?.newestLiveAt ?? 0, liveAt),
    });
  }
  if (list.source !== 'live' || list.via !== 'handshake' || list.liveError || list.models.length === 0) return;
  try {
    const stored = store.get().providers[provider.id];
    if (stored && list.fetchedAt <= stored.at) return;
    let message: string | undefined;
    await store.update((file) => {
      const previous = file.providers[provider.id];
      // Cached reads, including an older concurrent refresh, cannot replace a newer snapshot.
      if (previous && list.fetchedAt <= previous.at) return file;
      const models = Object.fromEntries(list.models.map((m) => [m.id, { label: m.label, ...(m.resolvedId && { resolvedId: m.resolvedId }) }]));
      const seen = new Set([...(previous?.seen ?? Object.keys(models)),
        ...Object.entries(previous?.models ?? {}).map(([id, info]) => info.resolvedId ?? id)]);
      const added = list.models.filter((m) => !m.hidden && m.id !== 'default' && m.id !== 'auto' && !seen.has(m.id) && !seen.has(m.resolvedId ?? m.id));
      const missingNotified = new Set(previous?.missingNotified ?? []);
      const id = provider.id;
      const saved = getPresets();
      const mapped = isPresetProvider(id)
        ? AUTO_LEVELS.flatMap((level) => [
          saved[id]?.[level],
          ...(level === 'minimum' || level === 'maximum' ? [] : [BUILTIN_PRESETS[id][level]]),
        ])
        : [];
      const missing = [...new Set(mapped.flatMap((cell) => {
        if (!cell || missingNotified.has(cell.model)) return [];
        const accepted = (catalog: ModelList) => provider.acceptsModel
          ? provider.acceptsModel(cell.model, catalog)
          : catalog.models.some((m) => m.id === cell.model);
        const old: ModelList = { ...list, models: Object.entries(previous?.models ?? {}).map(([id, info]) => ({ id, ...info })) };
        return previous && accepted(old) && !accepted(list) ? [cell.model] : [];
      }))];
      if (previous && (added.length || missing.length)) {
        const changes = [
          ...(added.length ? [`New models for ${provider.displayName}: ${added.map((m) => m.label).join(', ')}.`] : []),
          ...(missing.length ? [`Models no longer offered for ${provider.displayName}: ${missing.map((id) => previous.models[id]?.label ?? id).join(', ')}.`] : []),
        ];
        message = `${changes.join(' ')} Review Smart selection`;
      }
      for (const [id, info] of Object.entries(models)) { seen.add(id); if (info.resolvedId) seen.add(info.resolvedId); }
      for (const id of missing) missingNotified.add(id);
      const next: CatalogFile = {
        version: 1,
        providers: { ...file.providers, [provider.id]: { at: list.fetchedAt, models, seen: [...seen], missingNotified: [...missingNotified] } },
      };
      // Keep exact dedupe history rather than evicting ids and rediscovering returning models.
      if (Buffer.byteLength(JSON.stringify(next, null, 2), 'utf8') > MAX_CATALOG_BYTES) {
        throw new RangeError('Model catalog storage limit reached');
      }
      return next;
    });
    // Save seen state before delivery, so dismissal and restart cannot rediscover the same model.
    if (message && getOrchestratorSettings().enabled.includes(provider.id)) {
      broadcastToAllWindows(IPC.APP.MODEL_CATALOG_NOTICE, message);
    }
  } catch (err) {
    // telemetry-exempt: a failed notice must not turn a successful provider read into a fallback.
    appLog('core:mcp', 'warn', 'Could not save model catalog changes', { meta: { provider: provider.id, error: err instanceof Error ? err.name : 'unknown' } });
  }
}
