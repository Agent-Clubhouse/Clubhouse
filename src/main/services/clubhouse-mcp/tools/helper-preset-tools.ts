/**
 * Helper presets over the Clubhouse MCP (#2785): read them, and change or
 * reset them, through the same service as Settings > Smart selection and the phone
 * (`readHelperRouting`, `updateHelperPresets`). No second write path.
 *
 * Reading is an app settings read (`settings.app.read`), which every agent
 * holds: presets hold no secrets. Changing them is an app settings write
 * (`settings.app.write`), checked by the grant check on every call (#2968).
 * No agent holds it with Allow by default: the Dispatcher's is Ask first, so
 * each change waits for the user in Needs you (#2970), and other agents are
 * refused until a person grants it. Agent text can't grant it, and helpers
 * never inherit it.
 */

import { registerGlobalTool } from '../tool-registry';
import { HelperRoutingError, readHelperRouting, updateHelperPresets } from '../../helper-routing';
import { PRESET_PROVIDERS, type HelperRoutingUpdate } from '../../../../shared/helper-routing';
import type { McpToolResult } from '../types';

const json = (value: unknown, isError = false): McpToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError: true }) });

/** Only the parts of an update this tool takes: cells and resets, never Auto (a separate setting). */
function parseUpdate(args: Record<string, unknown>): HelperRoutingUpdate | string {
  if (typeof args.revision !== 'string' || !args.revision) return 'revision is required: send the revision read_helper_presets returned.';
  const update: HelperRoutingUpdate = { revision: args.revision };
  if (args.cells !== undefined) {
    if (!Array.isArray(args.cells)) return 'cells must be a list of { provider, difficulty, model, effort }.';
    update.cells = args.cells as HelperRoutingUpdate['cells'];
  }
  if (args.reset !== undefined) {
    if (typeof args.reset !== 'object' || args.reset === null || Array.isArray(args.reset)) return 'reset must be {}, { provider } or { provider, difficulty }.';
    update.reset = args.reset as HelperRoutingUpdate['reset'];
  }
  if (!update.cells?.length && !update.reset) return 'Send cells to set, or reset.';
  return update;
}

export function registerHelperPresetTools(): void {
  registerGlobalTool(
    'read_helper_presets',
    {
      description: 'Read the helper presets: for each CLI with presets and each level, the model and effort it uses, '
        + 'whether it is custom or built in, whether it is still valid, the choices, and the revision to send with a change. '
        + 'Levels are easy, medium and hard (the difficulties start_helper takes), plus minimum and maximum, the cheapest and strongest choices. '
        + 'An unset minimum or maximum uses easy or hard, shown by `follows`. '
        + 'A model whose `efforts` is empty takes effort null. `autoCandidate` says whether cli "auto" chooses that CLI (Copilot: no). App-wide. Changes nothing.',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => {
      const settings = await readHelperRouting();
      return json({ revision: settings.revision, providers: settings.providers });
    },
    { grant: { actions: ['settings.app.read'], target: 'app' } },
  );

  registerGlobalTool(
    'set_helper_presets',
    {
      description: 'Change or reset helper presets, app-wide. Needs the app settings permission. Send the revision you read; '
        + 'a stale one changes nothing and returns the current values. cells: [{ provider, difficulty, model, effort }], '
        + `where provider is one of ${PRESET_PROVIDERS.join(', ')}, difficulty is any level`
        + ': minimum, easy, medium, hard or maximum, '
        + 'and effort is one of the model\'s efforts, or null when it lists none; '
        + 'reset: {} for all, { provider } or { provider, difficulty }. A reset minimum or maximum uses easy or hard again.',
      inputSchema: {
        type: 'object',
        properties: {
          revision: { type: 'string' },
          cells: { type: 'array', items: { type: 'object' } },
          reset: { type: 'object' },
        },
        required: ['revision'],
      },
    },
    async (_agentId, args) => {
      const update = parseUpdate(args);
      if (typeof update === 'string') return json({ ok: false, code: 'invalid_helper_routing', message: update }, true);
      try {
        const settings = await updateHelperPresets(update, { surface: 'mcp' });
        return json({ ok: true, revision: settings.revision, providers: settings.providers });
      } catch (err) {
        if (err instanceof HelperRoutingError) {
          return json({ ok: false, code: err.code, message: err.message, ...(err.settings && { revision: err.settings.revision, providers: err.settings.providers }) }, true);
        }
        throw err;
      }
    },
    { grant: { actions: ['settings.app.write'], target: 'app' } },
  );
}
