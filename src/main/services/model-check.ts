/**
 * Checks of a model and an effort against a CLI's own list (#2569, #2671), for
 * start_helper and the helper presets. A model or level missing from a live list
 * is refused, and one missing from a fallback list only gets a warning, since
 * that list can be stale.
 */

import { resolveProfileEnv } from './agent-system';
import { appLog } from './log-service';
import { getProvider } from '../orchestrators';
import type { ModelInfo, ModelList, OrchestratorId, OrchestratorProvider } from '../orchestrators';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The provider's model list under the project's profile, or null when the provider can't list models. */
export async function modelListFor(provider: OrchestratorProvider, projectPath: string | undefined, refresh = false): Promise<ModelList | null> {
  if (!provider.listModels) return null;
  const env = projectPath ? await resolveProfileEnv(projectPath, provider.id) : undefined;
  return provider.listModels({ ...(env && { env }), ...(refresh && { refresh: true }) });
}

function accepts(provider: OrchestratorProvider, model: string, list: ModelList): boolean {
  return provider.acceptsModel
    ? provider.acceptsModel(model, list)
    : model === 'default' || list.models.some((m) => m.id === model);
}

function listedIds(list: ModelList): string {
  return list.models.filter((m) => !m.hidden).map((m) => m.id).join(', ');
}

export type ModelCheck = { ok: true; warning?: string } | { ok: false; message: string };

/**
 * Check `model` for a helper on `cli` (the provider id it will run on),
 * with the profile of the project it is created in. Never throws: if the
 * list can't be read at all, the start goes ahead with a warning.
 */
export async function checkHelperModel(cli: string | undefined, model: string, projectPath: string | undefined): Promise<ModelCheck> {
  const provider = cli ? getProvider(cli as OrchestratorId) : undefined;
  if (!provider?.listModels) return { ok: true };
  let list: ModelList | null;
  try {
    list = await modelListFor(provider, projectPath);
  } catch (err) {
    // telemetry-exempt: logged; the caller is warned in the start_helper result
    appLog('core:mcp', 'warn', 'start_helper: could not list models', { meta: { cli, error: errorText(err) } });
    return { ok: true, warning: `Could not check model "${model}" for ${cli}: ${errorText(err)}` };
  }
  if (!list || accepts(provider, model, list)) return { ok: true };
  if (list.source === 'live') {
    return {
      ok: false,
      message: `Model "${model}" is not one ${cli} accepts. Valid ids: ${listedIds(list)}. Call list_models for details.`,
    };
  }
  return {
    ok: true,
    warning:
      `Model "${model}" is not in ${cli}'s fallback model list (${listedIds(list)}), which may be stale` +
      `${list.liveError ? ` because its live list was unavailable: ${list.liveError}` : ''}. ` +
      'The helper was started with it anyway; if its CLI rejects the model, it fails to start or uses its default.',
  };
}

/** The list's entry for `model`: by id or resolved id, without a `[1m]`; no model means the CLI's default. */
function modelEntry(list: ModelList, model: string | undefined): ModelInfo | undefined {
  if (!model || model === 'default') return list.models.find((m) => m.isDefault);
  const base = model.replace(/\[1m\]$/i, '');
  return list.models.find((m) => m.id === model || m.id === base || m.resolvedId === base);
}

/**
 * Check `effort` for a helper on `cli` with `model` (unset for the CLI's
 * default), as checkHelperModel checks a model: a live list refuses a level the
 * model doesn't have, and a fallback list only warns. A warning, never a
 * refusal, when nothing says what the model takes: the list can't be read, it
 * has no levels at all (Copilot's doesn't report them), or it doesn't have the
 * model (an alias the CLI accepts). Never throws.
 */
export async function checkHelperEffort(cli: string | undefined, model: string | undefined, effort: string, projectPath: string | undefined): Promise<ModelCheck> {
  const unchecked = (why: string): ModelCheck => ({
    ok: true,
    warning: `Could not check effort "${effort}" for ${cli ?? 'this CLI'}: ${why} The helper is started with it anyway; if its CLI rejects it, it fails to start or uses its default.`,
  });
  const provider = cli ? getProvider(cli as OrchestratorId) : undefined;
  if (!provider?.listModels) return unchecked('it has no model list.');
  let list: ModelList | null;
  try {
    list = await modelListFor(provider, projectPath);
  } catch (err) {
    // telemetry-exempt: logged; the caller is warned in the start_helper result
    appLog('core:mcp', 'warn', 'start_helper: could not list models', { meta: { cli, error: errorText(err) } });
    return unchecked(`${errorText(err)}.`);
  }
  if (!list || !list.models.some((m) => m.efforts?.length)) return unchecked('its model list doesn\'t report effort levels.');
  const entry = modelEntry(list, model);
  const name = model && model !== 'default' ? `Model "${model}"` : `${cli}'s default model`;
  if (!entry) return unchecked(`its model list doesn't have ${model && model !== 'default' ? `"${model}"` : 'a default model'}.`);
  const levels = entry.efforts ?? [];
  if (levels.includes(effort)) return { ok: true };
  const problem = levels.length > 0 ? `${name} doesn't take effort "${effort}". Its levels: ${levels.join(', ')}.` : `${name} takes no effort level.`;
  if (list.source === 'live') return { ok: false, message: `${problem} Call list_models for details.` };
  return {
    ok: true,
    warning: `${problem} That is from ${cli}'s fallback model list, which may be stale, so the helper is started with it anyway; if its CLI rejects it, it fails to start or uses its default.`,
  };
}
