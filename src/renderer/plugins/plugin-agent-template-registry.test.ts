import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPluginAgentTemplate,
  getPluginAgentTemplates,
  getPluginAgentTemplatesByPlugin,
  onTemplateRegistryChange,
  unregisterAllTemplatesForPlugin,
  _resetTemplateRegistryForTesting,
  type PluginAgentTemplate,
} from './plugin-agent-template-registry';

const template1: PluginAgentTemplate = {
  name: 'Code Reviewer',
  description: 'Reviews code changes',
  promptContent: '# Code Reviewer\n\nYou review code.',
  skills: { review: '# Review skill' },
};

const template2: PluginAgentTemplate = {
  name: 'Test Writer',
  description: 'Writes tests',
  promptContent: '# Test Writer\n\nYou write tests.',
};

const template3: PluginAgentTemplate = {
  name: 'Debugger',
  promptContent: '# Debugger\n\nYou debug issues.',
  icon: '<svg>...</svg>',
};

describe('plugin-agent-template-registry', () => {
  beforeEach(() => {
    _resetTemplateRegistryForTesting();
  });

  describe('registerPluginAgentTemplate', () => {
    it('adds a template to the registry', () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      const templates = getPluginAgentTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].pluginId).toBe('my-plugin');
      expect(templates[0].pluginName).toBe('My Plugin');
      expect(templates[0].template).toBe(template1);
    });

    it('returns a Disposable that removes the template', () => {
      const disposable = registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      expect(getPluginAgentTemplates()).toHaveLength(1);
      disposable.dispose();
      expect(getPluginAgentTemplates()).toHaveLength(0);
    });

    it('supports multiple templates from the same plugin', () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template2);
      expect(getPluginAgentTemplates()).toHaveLength(2);
    });

    it('supports templates from different plugins', () => {
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template1);
      registerPluginAgentTemplate('plugin-b', 'Plugin B', template2);
      expect(getPluginAgentTemplates()).toHaveLength(2);
    });
  });

  describe('getPluginAgentTemplatesByPlugin', () => {
    it('groups templates by plugin ID', () => {
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template1);
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template2);
      registerPluginAgentTemplate('plugin-b', 'Plugin B', template3);

      const grouped = getPluginAgentTemplatesByPlugin();
      expect(grouped.size).toBe(2);
      expect(grouped.get('plugin-a')).toHaveLength(2);
      expect(grouped.get('plugin-b')).toHaveLength(1);
    });

    it('returns empty map when no templates registered', () => {
      const grouped = getPluginAgentTemplatesByPlugin();
      expect(grouped.size).toBe(0);
    });
  });

  describe('unregisterAllTemplatesForPlugin', () => {
    it('removes all templates for a specific plugin', () => {
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template1);
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template2);
      registerPluginAgentTemplate('plugin-b', 'Plugin B', template3);

      unregisterAllTemplatesForPlugin('plugin-a');

      const templates = getPluginAgentTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].pluginId).toBe('plugin-b');
    });

    it('does nothing for unknown plugin', () => {
      registerPluginAgentTemplate('plugin-a', 'Plugin A', template1);
      unregisterAllTemplatesForPlugin('unknown');
      expect(getPluginAgentTemplates()).toHaveLength(1);
    });
  });

  describe('onTemplateRegistryChange', () => {
    it('notifies listeners on register', () => {
      const listener = vi.fn();
      onTemplateRegistryChange(listener);
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies listeners on dispose', () => {
      const listener = vi.fn();
      onTemplateRegistryChange(listener);
      const disposable = registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      listener.mockClear();
      disposable.dispose();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies listeners on unregisterAll', () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      const listener = vi.fn();
      onTemplateRegistryChange(listener);
      unregisterAllTemplatesForPlugin('my-plugin');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying after listener dispose', () => {
      const listener = vi.fn();
      const sub = onTemplateRegistryChange(listener);
      sub.dispose();
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      expect(listener).not.toHaveBeenCalled();
    });

    it('swallows listener errors', () => {
      const badListener = vi.fn(() => { throw new Error('boom'); });
      const goodListener = vi.fn();
      onTemplateRegistryChange(badListener);
      onTemplateRegistryChange(goodListener);
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      expect(goodListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('_resetTemplateRegistryForTesting', () => {
    it('clears all templates and listeners', () => {
      registerPluginAgentTemplate('my-plugin', 'My Plugin', template1);
      const listener = vi.fn();
      onTemplateRegistryChange(listener);

      _resetTemplateRegistryForTesting();

      expect(getPluginAgentTemplates()).toHaveLength(0);
      // Listener was cleared, so new registrations don't notify
      registerPluginAgentTemplate('other', 'Other', template2);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
