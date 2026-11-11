import { AUTO_LEVELS, BUILTIN_PRESETS, isPresetProvider } from '../../shared/helper-routing';
import { IPC } from '../../shared/ipc-channels';
import type { ModelInfo, ModelList, OrchestratorProvider } from '../orchestrators/types';
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
      const seen = new Set(previous?.seen ?? Object.keys(models));
      const added = list.models.filter((m) => !m.hidden && m.id !== 'default' && m.id !== 'auto' && !seen.has(m.id));
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
      for (const id of Object.keys(models)) seen.add(id);
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
