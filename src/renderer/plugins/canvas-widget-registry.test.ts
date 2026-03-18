import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerCanvasWidgetType,
  unregisterAllForPlugin,
  getRegisteredWidgetTypes,
  getRegisteredWidgetType,
  qualifyWidgetType,
  parsePluginWidgetType,
  onRegistryChange,
  generatePluginWidgetDisplayName,
  _resetRegistryForTesting,
} from './canvas-widget-registry';
import type { PluginCanvasWidgetDeclaration, CanvasWidgetDescriptor } from '../../shared/plugin-types';
import React from 'react';

function makeDeclaration(id: string, label = 'Test Widget'): PluginCanvasWidgetDeclaration {
  return { id, label, icon: '+', metadataKeys: ['key1'] };
}

function makeDescriptor(id: string, generateDisplayName?: (m: any) => string): CanvasWidgetDescriptor {
  return {
    id,
    component: (() => React.createElement('div')) as any,
    generateDisplayName,
  };
}

describe('canvas-widget-registry', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  // ── qualifyWidgetType / parsePluginWidgetType ──────────────────────

  describe('qualifyWidgetType', () => {
    it('creates a qualified type string', () => {
      expect(qualifyWidgetType('my-plugin', 'chart')).toBe('plugin:my-plugin:chart');
    });
  });

  describe('parsePluginWidgetType', () => {
    it('parses a qualified type', () => {
      expect(parsePluginWidgetType('plugin:my-plugin:chart')).toEqual({
        pluginId: 'my-plugin',
        widgetId: 'chart',
      });
    });

    it('returns null for non-plugin types', () => {
      expect(parsePluginWidgetType('agent')).toBeNull();
      expect(parsePluginWidgetType('file')).toBeNull();
    });

    it('handles colons in widget ID', () => {
      expect(parsePluginWidgetType('plugin:my-plugin:sub:thing')).toEqual({
        pluginId: 'my-plugin',
        widgetId: 'sub:thing',
      });
    });
  });

  // ── Registration ──────────────────────────────────────────────────

  describe('registerCanvasWidgetType', () => {
    it('registers a widget type and makes it retrievable', () => {
      const decl = makeDeclaration('chart');
      const desc = makeDescriptor('chart');
      registerCanvasWidgetType('my-plugin', decl, desc);

      const types = getRegisteredWidgetTypes();
      expect(types).toHaveLength(1);
      expect(types[0].qualifiedType).toBe('plugin:my-plugin:chart');
      expect(types[0].pluginId).toBe('my-plugin');
      expect(types[0].declaration).toBe(decl);
      expect(types[0].descriptor).toBe(desc);
    });

    it('returns a disposable that unregisters', () => {
      const disposable = registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      expect(getRegisteredWidgetTypes()).toHaveLength(1);

      disposable.dispose();
      expect(getRegisteredWidgetTypes()).toHaveLength(0);
    });

    it('can register multiple widget types from different plugins', () => {
      registerCanvasWidgetType('plugin-a', makeDeclaration('chart'), makeDescriptor('chart'));
      registerCanvasWidgetType('plugin-b', makeDeclaration('table'), makeDescriptor('table'));

      const types = getRegisteredWidgetTypes();
      expect(types).toHaveLength(2);
      expect(types.map((t) => t.qualifiedType)).toEqual([
        'plugin:plugin-a:chart',
        'plugin:plugin-b:table',
      ]);
    });

    it('can register multiple widget types from same plugin', () => {
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      registerCanvasWidgetType('my-plugin', makeDeclaration('table'), makeDescriptor('table'));

      expect(getRegisteredWidgetTypes()).toHaveLength(2);
    });
  });

  describe('getRegisteredWidgetType', () => {
    it('returns the entry for a qualified type', () => {
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      const entry = getRegisteredWidgetType('plugin:my-plugin:chart');
      expect(entry).toBeDefined();
      expect(entry!.pluginId).toBe('my-plugin');
    });

    it('returns undefined for unregistered types', () => {
      expect(getRegisteredWidgetType('plugin:unknown:thing')).toBeUndefined();
    });
  });

  describe('unregisterAllForPlugin', () => {
    it('removes all widget types for a plugin', () => {
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      registerCanvasWidgetType('my-plugin', makeDeclaration('table'), makeDescriptor('table'));
      registerCanvasWidgetType('other-plugin', makeDeclaration('map'), makeDescriptor('map'));

      unregisterAllForPlugin('my-plugin');

      const types = getRegisteredWidgetTypes();
      expect(types).toHaveLength(1);
      expect(types[0].pluginId).toBe('other-plugin');
    });

    it('is a no-op for unknown plugins', () => {
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      unregisterAllForPlugin('unknown');
      expect(getRegisteredWidgetTypes()).toHaveLength(1);
    });
  });

  // ── Change listeners ──────────────────────────────────────────────

  describe('onRegistryChange', () => {
    it('fires on register', () => {
      const listener = vi.fn();
      onRegistryChange(listener);
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires on dispose', () => {
      const listener = vi.fn();
      onRegistryChange(listener);
      const d = registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      listener.mockClear();
      d.dispose();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires on unregisterAllForPlugin', () => {
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      const listener = vi.fn();
      onRegistryChange(listener);
      unregisterAllForPlugin('my-plugin');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('can be disposed', () => {
      const listener = vi.fn();
      const sub = onRegistryChange(listener);
      sub.dispose();
      registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Display name generation ───────────────────────────────────────

  describe('generatePluginWidgetDisplayName', () => {
    it('uses descriptor callback if provided', () => {
      const decl = makeDeclaration('chart', 'Chart');
      const desc = makeDescriptor('chart', (meta) => `Chart: ${meta.title}`);
      const d = registerCanvasWidgetType('my-plugin', decl, desc);
      const entry = getRegisteredWidgetType('plugin:my-plugin:chart')!;

      expect(generatePluginWidgetDisplayName(entry, { title: 'Sales' })).toBe('Chart: Sales');
      d.dispose();
    });

    it('falls back to manifest label when callback is not provided', () => {
      const decl = makeDeclaration('chart', 'My Chart');
      const desc = makeDescriptor('chart');
      const d = registerCanvasWidgetType('my-plugin', decl, desc);
      const entry = getRegisteredWidgetType('plugin:my-plugin:chart')!;

      expect(generatePluginWidgetDisplayName(entry, {})).toBe('My Chart');
      d.dispose();
    });

    it('falls back to manifest label when callback throws', () => {
      const decl = makeDeclaration('chart', 'Fallback Label');
      const desc = makeDescriptor('chart', () => { throw new Error('boom'); });
      const d = registerCanvasWidgetType('my-plugin', decl, desc);
      const entry = getRegisteredWidgetType('plugin:my-plugin:chart')!;

      expect(generatePluginWidgetDisplayName(entry, {})).toBe('Fallback Label');
      d.dispose();
    });
  });
});
