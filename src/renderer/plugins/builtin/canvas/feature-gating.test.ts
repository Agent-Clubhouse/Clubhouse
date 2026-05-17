/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect } from 'vitest';
import { getBuiltinPlugins, getDefaultEnabledIds, CANVAS_SUB_PLUGIN_IDS } from '../index';

describe('canvas feature gating', () => {
  it('canvas IS always included in getBuiltinPlugins() (no experimental flag needed)', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('canvas');
  });

  it('stable canvas sub-plugins (group-project, sticky-note) are always loaded alongside canvas', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('group-project');
    expect(ids).toContain('sticky-note');
  });

  it('agent-queue is NOT loaded without experimental flag', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).not.toContain('agent-queue');
  });

  it('agent-queue IS loaded when agentQueue experimental flag is set', () => {
    const plugins = getBuiltinPlugins({ agentQueue: true });
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('agent-queue');
  });

  it('canvas IS in default enabled IDs', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('canvas')).toBe(true);
  });

  it('stable canvas sub-plugins (group-project, sticky-note) ARE in default enabled IDs', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('group-project')).toBe(true);
    expect(defaults.has('sticky-note')).toBe(true);
  });

  it('agent-queue is NOT in default enabled IDs (correctly experimental-gated)', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('agent-queue')).toBe(false);
  });

  it('agent-queue stays out of defaults even when its experimental flag is set', () => {
    // The experimental flag controls whether agent-queue is *loaded*, not whether
    // it is auto-enabled. Users still opt in explicitly via the plugin list.
    const defaults = getDefaultEnabledIds({ agentQueue: true });
    expect(defaults.has('agent-queue')).toBe(false);
  });

  it('CANVAS_SUB_PLUGIN_IDS contains group-project, agent-queue, and sticky-note', () => {
    expect(CANVAS_SUB_PLUGIN_IDS.has('group-project')).toBe(true);
    expect(CANVAS_SUB_PLUGIN_IDS.has('agent-queue')).toBe(true);
    expect(CANVAS_SUB_PLUGIN_IDS.has('sticky-note')).toBe(true);
  });

  it('base plugins always present regardless of flags', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    for (const id of ['hub', 'terminal', 'files']) {
      expect(ids).toContain(id);
    }
  });

  it('default enabled IDs include terminal, files, git, browser, review, canvas, group-project, sticky-note', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('terminal')).toBe(true);
    expect(defaults.has('files')).toBe(true);
    expect(defaults.has('git')).toBe(true);
    expect(defaults.has('browser')).toBe(true);
    expect(defaults.has('review')).toBe(true);
    expect(defaults.has('canvas')).toBe(true);
    expect(defaults.has('group-project')).toBe(true);
    expect(defaults.has('sticky-note')).toBe(true);
  });

  it('hub is NOT in default enabled IDs', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('hub')).toBe(false);
  });

  it('review is always loaded (not behind experimental flag)', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('review');
  });

  it('review is in default enabled IDs without experimental flags', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('review')).toBe(true);
  });

  it('PluginListSettings cascade-enables sub-plugins when canvas is enabled (structural)', () => {
    // Verify that when enabling canvas, sub-plugins are also enabled
    // (symmetric with cascade-disable on canvas off).
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../features/settings/PluginListSettings.tsx'), 'utf-8');

    // The handleToggle function should cascade-enable canvas sub-plugins
    const enableBlock = source.slice(
      source.indexOf("pluginId === 'canvas'", source.indexOf('enableApp(pluginId)')),
      source.indexOf("pluginId === 'canvas'", source.indexOf('enableApp(pluginId)')) + 600,
    );
    expect(enableBlock).toContain('CANVAS_SUB_PLUGIN_IDS');
    expect(enableBlock).toContain('enableApp(subId)');
    expect(enableBlock).toContain('activatePlugin(subId)');
  });

  it('browser and git are loaded and in default enabled IDs', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('browser');
    expect(ids).toContain('git');

    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('browser')).toBe(true);
    expect(defaults.has('git')).toBe(true);
  });

  it('agent-queue manifest declares requiresMcp', () => {
    const plugins = getBuiltinPlugins({ agentQueue: true });
    const agentQueue = plugins.find((p) => p.manifest.id === 'agent-queue');
    expect(agentQueue).toBeDefined();
    expect(agentQueue!.manifest.requiresMcp).toBe(true);
  });

  it('group-project manifest declares requiresMcp', () => {
    const plugins = getBuiltinPlugins({});
    const groupProject = plugins.find((p) => p.manifest.id === 'group-project');
    expect(groupProject).toBeDefined();
    expect(groupProject!.manifest.requiresMcp).toBe(true);
  });

  it('sticky-note manifest does NOT declare requiresMcp', () => {
    const plugins = getBuiltinPlugins({});
    const stickyNote = plugins.find((p) => p.manifest.id === 'sticky-note');
    expect(stickyNote).toBeDefined();
    expect(stickyNote!.manifest.requiresMcp).toBeUndefined();
  });
});
