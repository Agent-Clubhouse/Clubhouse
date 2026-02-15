import { describe, it, expect } from 'vitest';
import { validateManifest, SUPPORTED_API_VERSIONS } from './manifest-validator';

describe('manifest-validator', () => {
  const validManifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.4 },
    scope: 'project',
    contributes: { help: {} },
  };

  describe('SUPPORTED_API_VERSIONS', () => {
    it('includes version 0.4', () => {
      expect(SUPPORTED_API_VERSIONS).toContain(0.4);
    });
  });

  describe('validateManifest', () => {
    it('accepts a valid project-scoped manifest', () => {
      const result = validateManifest(validManifest);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.errors).toHaveLength(0);
    });

    it('accepts a valid app-scoped manifest', () => {
      const result = validateManifest({ ...validManifest, scope: 'app' });
      expect(result.valid).toBe(true);
    });

    it('accepts manifest with all optional fields', () => {
      const result = validateManifest({
        ...validManifest,
        description: 'A test plugin',
        author: 'Test Author',
        main: './dist/main.js',
        settingsPanel: 'declarative',
        contributes: {
          tab: { label: 'Test', icon: 'puzzle', layout: 'sidebar-content' },
          commands: [{ id: 'test.run', title: 'Run Test' }],
          settings: [{ key: 'test.opt', type: 'boolean', label: 'Option', default: true }],
          help: {},
        },
      });
      expect(result.valid).toBe(true);
    });

    // --- Required field checks ---

    it('rejects null input', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('JSON object');
    });

    it('rejects non-object input', () => {
      const result = validateManifest('not an object');
      expect(result.valid).toBe(false);
    });

    it('rejects missing id', () => {
      const { id, ...rest } = validManifest;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: id');
    });

    it('rejects empty string id', () => {
      const result = validateManifest({ ...validManifest, id: '' });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid id format (uppercase)', () => {
      const result = validateManifest({ ...validManifest, id: 'MyPlugin' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must match');
    });

    it('rejects invalid id format (spaces)', () => {
      const result = validateManifest({ ...validManifest, id: 'my plugin' });
      expect(result.valid).toBe(false);
    });

    it('accepts id with hyphens', () => {
      const result = validateManifest({ ...validManifest, id: 'my-cool-plugin' });
      expect(result.valid).toBe(true);
    });

    it('accepts id with numbers', () => {
      const result = validateManifest({ ...validManifest, id: 'plugin2' });
      expect(result.valid).toBe(true);
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validManifest;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: name');
    });

    it('rejects missing version', () => {
      const { version, ...rest } = validManifest;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: version');
    });

    // --- Engine checks ---

    it('rejects missing engine', () => {
      const { engine, ...rest } = validManifest;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: engine');
    });

    it('rejects non-numeric engine.api', () => {
      const result = validateManifest({ ...validManifest, engine: { api: 'v1' } });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('engine.api must be a number');
    });

    it('rejects unsupported API version', () => {
      const result = validateManifest({ ...validManifest, engine: { api: 99 } });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('not supported by this version of Clubhouse');
    });

    // --- Scope checks ---

    it('rejects invalid scope', () => {
      const result = validateManifest({ ...validManifest, scope: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid scope');
    });

    // --- Scope/contributes consistency ---

    it('rejects project-scoped plugin with railItem', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'project',
        contributes: { railItem: { label: 'Test' }, help: {} },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('cannot contribute railItem');
    });

    it('rejects app-scoped plugin with tab', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'app',
        contributes: { tab: { label: 'Test' }, help: {} },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('cannot contribute tab');
    });

    it('collects multiple errors at once', () => {
      const result = validateManifest({
        id: 'INVALID',
        scope: 'bad',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });

    it('ignores unknown fields (forward compatibility)', () => {
      const result = validateManifest({
        ...validManifest,
        futureField: 'value',
        experimental: { option: true },
      });
      expect(result.valid).toBe(true);
    });

    // --- Dual scope ---

    it('accepts a valid dual-scoped manifest', () => {
      const result = validateManifest({ ...validManifest, scope: 'dual' });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-scoped plugin with both tab and railItem', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'dual',
        contributes: {
          tab: { label: 'Tab' },
          railItem: { label: 'Rail' },
          help: {},
        },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-scoped plugin with only tab', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'dual',
        contributes: { tab: { label: 'Tab' }, help: {} },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-scoped plugin with only railItem', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'dual',
        contributes: { railItem: { label: 'Rail' }, help: {} },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-scoped plugin with no contributes besides help', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'dual',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-scoped plugin with tab, railItem, and commands', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'dual',
        contributes: {
          tab: { label: 'Tab' },
          railItem: { label: 'Rail' },
          commands: [{ id: 'do-thing', title: 'Do Thing' }],
          help: {},
        },
      });
      expect(result.valid).toBe(true);
    });

    it('still rejects project-scoped with railItem after dual support', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'project',
        contributes: { railItem: { label: 'Rail' }, help: {} },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('cannot contribute railItem');
    });

    it('still rejects app-scoped with tab after dual support', () => {
      const result = validateManifest({
        ...validManifest,
        scope: 'app',
        contributes: { tab: { label: 'Tab' }, help: {} },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('cannot contribute tab');
    });

    it('error message lists all three valid scopes', () => {
      const result = validateManifest({ ...validManifest, scope: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('"project"');
      expect(result.errors[0]).toContain('"app"');
      expect(result.errors[0]).toContain('"dual"');
    });

    it('rejects scope of boolean type', () => {
      const result = validateManifest({ ...validManifest, scope: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid scope');
    });

    it('rejects scope of number type', () => {
      const result = validateManifest({ ...validManifest, scope: 42 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid scope');
    });

    it('accepts empty contributes object with help', () => {
      const result = validateManifest({
        ...validManifest,
        contributes: { help: {} },
      });
      expect(result.valid).toBe(true);
    });

    // --- v0.4 help validation ---

    it('rejects v0.4 manifest without contributes.help', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.4 },
        contributes: {},
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('contributes.help');
    });

    it('accepts v0.4 manifest with contributes.help: {}', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.4 },
        contributes: { help: {} },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts v0.4 manifest with valid help topics', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.4 },
        contributes: {
          help: {
            topics: [
              { id: 'getting-started', title: 'Getting Started', content: '# Hello' },
            ],
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects v0.4 manifest with malformed help topics', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.4 },
        contributes: {
          help: {
            topics: [
              { id: '', title: '', content: '' },
            ],
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('topics[0].id'))).toBe(true);
    });

    it('rejects v0.4 manifest with no contributes at all', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.4 },
        contributes: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('contributes.help');
    });
  });
});
