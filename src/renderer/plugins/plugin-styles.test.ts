import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Uses jsdom environment from vitest config — no need for manual DOM mocking.

import { injectStyles, removeStyles } from './plugin-styles';

describe('plugin-styles', () => {
  beforeEach(() => {
    // Clean up any leftover style elements from previous tests
    document.querySelectorAll('style[id^="plugin-styles-"]').forEach(el => el.remove());
  });

  afterEach(() => {
    document.querySelectorAll('style[id^="plugin-styles-"]').forEach(el => el.remove());
  });

  describe('injectStyles', () => {
    it('creates a style element', () => {
      injectStyles('test-plugin', 'body { color: red; }');
      const el = document.getElementById('plugin-styles-test-plugin');
      expect(el).not.toBeNull();
      expect(el?.tagName).toBe('STYLE');
      expect(el?.textContent).toBe('body { color: red; }');
    });

    it('replaces existing styles for the same plugin', () => {
      injectStyles('test-plugin', 'body { color: red; }');
      injectStyles('test-plugin', 'body { color: blue; }');
      const matches = document.querySelectorAll('#plugin-styles-test-plugin');
      expect(matches.length).toBe(1);
      expect(matches[0].textContent).toBe('body { color: blue; }');
    });

    it('does not affect other plugins styles', () => {
      injectStyles('plugin-a', '.a { }');
      injectStyles('plugin-b', '.b { }');
      expect(document.getElementById('plugin-styles-plugin-a')?.textContent).toBe('.a { }');
      expect(document.getElementById('plugin-styles-plugin-b')?.textContent).toBe('.b { }');
    });
  });

  describe('removeStyles', () => {
    it('removes the style element for a plugin', () => {
      injectStyles('test-plugin', 'body { }');
      expect(document.getElementById('plugin-styles-test-plugin')).not.toBeNull();
      removeStyles('test-plugin');
      expect(document.getElementById('plugin-styles-test-plugin')).toBeNull();
    });

    it('does nothing if no styles exist for the plugin', () => {
      expect(() => removeStyles('nonexistent')).not.toThrow();
    });

    it('does not affect other plugins', () => {
      injectStyles('plugin-a', '.a { }');
      injectStyles('plugin-b', '.b { }');
      removeStyles('plugin-a');
      expect(document.getElementById('plugin-styles-plugin-a')).toBeNull();
      expect(document.getElementById('plugin-styles-plugin-b')).not.toBeNull();
    });
  });
});
