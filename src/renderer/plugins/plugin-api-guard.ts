/**
 * The plugin API boundary for D126's rule (#3174). Each namespace the factory
 * builds is guarded here against PLUGIN_API_GRANTS: while the plugin answers
 * an agent's MCP tool call, a method that changes state runs only if that
 * agent could make the change itself. Outside a call a method runs as it
 * always has. Reads and plugin-local methods aren't wrapped at all.
 *
 * This covers plugins that use the plugin API. Plugins share the renderer, so
 * it isn't isolation from a malicious plugin (see plugin-mcp-host.ts).
 */

import { ACCESS_LEVELS, accessLabel, type AccessLevel } from '../../shared/agent-access';
import { PLUGIN_API_GRANTS, type GuardScope, type PluginApiDeclaration, type PluginApiCheck } from './plugin-api-grants';
import { checkAnsweringCallers, pluginAnsweringLevel, withAnsweringLevel } from './plugin-mcp-host';
import { pluginCommandRegistry } from './plugin-commands';
import { FILES_BASE } from './plugin-api-files';


type Method = (this: unknown, ...args: unknown[]) => unknown;

const rank = (level: AccessLevel) => ACCESS_LEVELS.indexOf(level);

function refusal(pluginId: string, name: string, reason: string): Error {
  return new Error(`Plugin '${pluginId}' can't use ${name} while answering an agent's tool call: ${reason} Ask the person to do it.`);
}

/** Throws a refusal for any check the agent behind the open calls fails; resolves once main has said yes to every grant. */
function runChecks(pluginId: string, name: string, level: AccessLevel, checks: PluginApiCheck[]): Promise<void> | void {
  const grants: Array<Extract<PluginApiCheck, { grant: unknown }>> = [];
  for (const c of checks) {
    if ('refuse' in c) throw refusal(pluginId, name, c.refuse);
    if ('ownCommand' in c && !pluginCommandRegistry.has(c.ownCommand)) {
      throw refusal(pluginId, name, 'It runs a command another plugin or Clubhouse registered, whose effects can\'t be checked for the agent.');
    }
    if ('access' in c && rank(level) < rank(c.access)) {
      throw new Error(`Plugin '${pluginId}' is answering a tool call from an agent that runs at ${accessLabel(level)}, so it can't ${c.what} (${name}): that acts at ${accessLabel(c.access)}, and no agent acts above its own level, even through a plugin. Ask the person to do it.`);
    }
    if ('grant' in c) grants.push(c);
  }
  if (grants.length === 0) return;
  return (async () => {
    for (const g of grants) {
      const refused = await checkAnsweringCallers(pluginId, 'agentId' in g ? { action: g.grant, agentId: g.agentId } : { action: g.grant, projectPath: g.projectPath });
      if (refused) throw new Error(refused);
    }
  })();
}

function guardMethod(name: string, fn: Method, decl: PluginApiDeclaration | undefined, scope: GuardScope): Method {
  const pluginId = scope.ctx.pluginId;
  // Every state-changing method returns a promise but the ones declared sync, so a refusal is a rejection.
  const fail = (err: unknown) => { if (decl?.kind === 'change' && decl.sync) throw err; return Promise.reject(err); };
  if (decl?.kind === 'scope') {
    // The API it returns is guarded the same way, whenever it is used.
    return function guardedScope(this: unknown, ...args: unknown[]) {
      const result = fn.apply(this, args) as Record<PropertyKey, unknown> | undefined;
      if (!result || typeof result !== 'object') return result;
      return guardNamespace(decl.as, result, { ...scope, base: result[FILES_BASE] as string | undefined });
    };
  }
  return function guarded(this: unknown, ...args: unknown[]) {
    const level = pluginAnsweringLevel(pluginId);
    if (!level) return fn.apply(this, args);
    try {
      // Undeclared (the parity test keeps this from shipping): refused during a call, never allowed unchecked.
      if (!decl || decl.kind !== 'change') throw refusal(pluginId, name, 'It isn\'t declared in the plugin API\'s permission table.');
      const pending = runChecks(pluginId, name, level, decl.checks(args, scope));
      if (!pending) return fn.apply(this, args);
      // The level it was checked against holds for the method's own checks, even if the call ended meanwhile.
      return pending.then(() => withAnsweringLevel(pluginId, level, () => fn.apply(this, args)));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Whether any declaration lives under `prefix.` (a nested namespace such as storage.project). */
const hasNested = (prefix: string) => Object.keys(PLUGIN_API_GRANTS).some((k) => k.startsWith(`${prefix}.`));

/**
 * A namespace with its state-changing methods guarded: a copy when any is, keeping getters, symbols
 * and plain values as they are, else the namespace itself (a cached one such as widgets stays the same object).
 */
export function guardNamespace<T>(ns: string, obj: T, scope: GuardScope): T {
  if (!obj || typeof obj !== 'object') return obj;
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  let changed = false;
  for (const key of Object.keys(descriptors)) {
    const d = descriptors[key];
    if (!('value' in d)) continue;
    const name = `${ns}.${key}`;
    const decl = PLUGIN_API_GRANTS[name];
    if (typeof d.value === 'function') {
      if (decl?.kind === 'read' || decl?.kind === 'plugin') continue;
      d.value = guardMethod(name, d.value as Method, decl, scope);
      changed = true;
    } else if (d.value && typeof d.value === 'object' && Object.getPrototypeOf(d.value) === Object.prototype && hasNested(name)) {
      const inner = guardNamespace(name, d.value, scope);
      if (inner !== d.value) { d.value = inner; changed = true; }
    }
  }
  return changed ? Object.create(Object.getPrototypeOf(obj), descriptors) as T : obj;
}
