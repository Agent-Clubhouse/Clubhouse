/**
 * Model tools (#2569): list_models tells an orchestrator which models each
 * CLI accepts, and checkHelperModel checks start_helper's `model` against the
 * same list before a helper is created.
 *
 * Each provider lists its own models (BaseProvider.listModels): from the
 * CLI's handshake where it has one (`source: "live"`), else its older probe
 * or its static list (`source: "fallback"`). A model missing from a live list
 * is refused; one missing from a fallback list only gets a warning, since
 * that list can be stale.
 *
 * The CLIs are asked from an empty temp dir, so a list reflects each CLI's
 * login and user-level settings; a project-level model restriction isn't
 * applied (LIST_SCOPE_NOTE).
 *
 * list_models is in the `orchestration` tool group with start_helper, so any
 * agent that can start a helper, in its own project or another, can call it.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { agentRegistry } from '../../agent-registry';
import { resolveProfileEnv } from '../../agent-system';
import { getSettings as getOrchestratorSettings } from '../../orchestrator-settings';
import { appLog } from '../../log-service';
import { getAllProviders, getProvider } from '../../../orchestrators';
import type { ModelInfo, ModelList, OrchestratorId, OrchestratorProvider } from '../../../orchestrators';
import { McpArgError, optionalString } from './validation';

/** Told to the caller with every list: what a list does and doesn't reflect. */
export const LIST_SCOPE_NOTE =
  'Each list reflects the CLI\'s login and user-level settings. A project-level model restriction is not applied.';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The provider's model list under the project's profile, or null when the provider can't list models. */
async function modelListFor(provider: OrchestratorProvider, projectPath: string | undefined, refresh = false): Promise<ModelList | null> {
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

// ── start_helper's model check ───────────────────────────────────────────

export type ModelCheck = { ok: true; warning?: string } | { ok: false; message: string };

/**
 * Check `model` for a helper on `cli` (the provider id it will run on),
 * with the profile of the project it is created in. Never throws: if the
 * list can't be read at all, the start goes ahead with a warning.
 */
export async function checkHelperModel(cli: string | undefined, model: string, projectPath: string): Promise<ModelCheck> {
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

// ── list_models ──────────────────────────────────────────────────────────

function describeModel(m: ModelInfo): Record<string, unknown> {
  return {
    id: m.id,
    label: m.label,
    ...(m.isDefault && { default: true }),
    ...(m.resolvedId && { resolvesTo: m.resolvedId }),
    ...(m.efforts?.length && { efforts: m.efforts }),
    ...(m.costHint && { costHint: m.costHint }),
    ...(m.hidden && { hidden: true }),
    ...(m.description && { description: m.description }),
  };
}

/** Providers listed when no `cli` is given: those enabled in Settings, in registration order. */
function enabledProviders(): OrchestratorProvider[] {
  const all = getAllProviders();
  const enabled = getOrchestratorSettings().enabled ?? [];
  const picked = all.filter((p) => enabled.includes(p.id));
  return picked.length > 0 ? picked : all;
}

async function describeProvider(provider: OrchestratorProvider, projectPath: string | undefined, refresh: boolean): Promise<Record<string, unknown>> {
  try {
    const list = await modelListFor(provider, projectPath, refresh);
    if (!list) {
      const models = await provider.getModelOptions();
      return { cli: provider.id, name: provider.displayName, source: 'fallback', via: 'static', models: models.map((m) => describeModel(m)) };
    }
    return {
      cli: provider.id,
      name: provider.displayName,
      source: list.source,
      via: list.via,
      ...(list.liveError && { liveError: list.liveError }),
      models: list.models.map(describeModel),
    };
  } catch (err) {
    // telemetry-exempt: the error reaches the calling agent in the tool result
    return { cli: provider.id, name: provider.displayName, error: errorText(err), models: [] };
  }
}

async function listModels(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const cli = optionalString(args, 'cli')?.trim() || undefined;
  const refresh = args.refresh === true;
  let providers: OrchestratorProvider[];
  if (cli) {
    const provider = getProvider(cli as OrchestratorId);
    if (!provider) throw new McpArgError(`Unknown cli "${cli}". Available: ${getAllProviders().map((p) => p.id).join(', ')}`);
    providers = [provider];
  } else {
    providers = enabledProviders();
  }
  const projectPath = agentRegistry.get(agentId)?.projectPath;
  const listed = await Promise.all(providers.map((p) => describeProvider(p, projectPath, refresh)));
  return { content: [{ type: 'text', text: JSON.stringify({ note: LIST_SCOPE_NOTE, providers: listed }, null, 2) }] };
}

export function registerModelTools(): void {
  registerGlobalTool(
    'list_models',
    {
      description:
        'List the models each CLI accepts, to pick start_helper\'s model: pass a model\'s "id" as start_helper\'s ' +
        '"model", with that provider\'s "cli". Each model has a label and, where the CLI reports them, whether it ' +
        'is the CLI\'s default, its reasoning effort levels and a cost hint. "source" is "live" when the CLI listed ' +
        'the models itself, or "fallback" when Clubhouse fell back to an older or built-in list that may be stale. ' +
        'start_helper refuses a model missing from a live list and warns for one missing from a fallback list. ' +
        'Lists reflect each CLI\'s login and user-level settings; a project-level model restriction is not applied. ' +
        'Lists are cached for about ten minutes; refresh asks the CLIs again.',
      inputSchema: {
        type: 'object',
        properties: {
          cli: {
            type: 'string',
            description: 'Optional CLI provider id (e.g. claude-code, codex-cli, copilot-cli). Defaults to every enabled CLI.',
          },
          refresh: { type: 'boolean', description: 'Ask the CLIs again instead of using the cached lists.' },
        },
      },
    },
    async (agentId, args) => {
      try {
        return await listModels(agentId, args);
      } catch (err) {
        // telemetry-exempt: the error reaches the calling agent as the tool result
        if (!(err instanceof McpArgError)) appLog('core:mcp', 'warn', 'list_models failed', { meta: { agentId, error: errorText(err) } });
        return { content: [{ type: 'text', text: errorText(err) }], isError: true };
      }
    },
    { group: 'orchestration' },
  );
}
