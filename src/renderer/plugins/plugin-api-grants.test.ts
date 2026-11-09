import { describe, expect, it } from 'vitest';
import { createPluginAPI } from './plugin-api-factory';
import { PLUGIN_API_GRANTS } from './plugin-api-grants';
import { createFilesAPIForRoot } from './plugin-api-files';
import { guardNamespace } from './plugin-api-guard';
import { ALL_PLUGIN_PERMISSIONS, type PluginContext, type PluginManifest } from '../../shared/plugin-types';

/**
 * Every plugin API method says what it does (#3174), as every Clubhouse MCP
 * tool does (#2988): a method added without a declaration fails here, and is
 * refused while a plugin answers an agent's tool call until it has one.
 */

const ctx: PluginContext = { pluginId: 'p', pluginPath: '/p', scope: 'dual', projectId: 'proj', projectPath: '/proj', subscriptions: [], settings: {} };
const manifest = { id: 'p', name: 'P', version: '1', engine: { api: 0.9 }, scope: 'dual', permissions: [...ALL_PLUGIN_PERMISSIONS], contributes: { help: {} } } as PluginManifest;

/** Every function on the API, by dotted name, nested namespaces included. */
function methodsOf(prefix: string, obj: unknown, out: string[] = [], depth = 0): string[] {
  if (!obj || typeof obj !== 'object' || depth > 2) return out;
  for (const key of Object.keys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d || !('value' in d)) continue;
    if (typeof d.value === 'function') out.push(`${prefix}${key}`);
    else if (d.value && typeof d.value === 'object' && !Array.isArray(d.value)) methodsOf(`${prefix}${key}.`, d.value, out, depth + 1);
  }
  return out;
}

describe('the plugin API\'s permission table (#3174)', () => {
  const methods = methodsOf('', createPluginAPI(ctx, 'project', manifest));
  const external = methodsOf('files.', createFilesAPIForRoot('/elsewhere'));

  it('declares every method of the API', () => {
    expect(methods.length).toBeGreaterThan(150);
    expect(methods.filter((m) => !PLUGIN_API_GRANTS[m])).toEqual([]);
  });

  it('declares every method of a files API from forRoot, guarded as files', () => {
    expect(external.filter((m) => !PLUGIN_API_GRANTS[m])).toEqual([]);
  });

  it('has no declaration for a method that no longer exists', () => {
    const all = new Set([...methods, ...external]);
    expect(Object.keys(PLUGIN_API_GRANTS).filter((k) => !all.has(k))).toEqual([]);
  });

  it('a method with no declaration still runs outside an agent\'s call, as before', () => {
    let ran = false;
    const guarded = guardNamespace('notInTheTable', { act: () => { ran = true; return 1; } }, { ctx });
    expect(guarded.act()).toBe(1);
    expect(ran).toBe(true);
  });

  it('a namespace with nothing to guard is returned as it was, so cached ones keep their identity', () => {
    const widgets = { AgentAvatar: () => null };
    expect(guardNamespace('widgets', widgets, { ctx })).toBe(widgets);
  });
});
