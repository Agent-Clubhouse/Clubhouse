import { describe, it, expect } from 'vitest';
import { validateManifest, SUPPORTED_API_VERSIONS } from './manifest-validator';
import { PERMISSION_HIERARCHY } from '../../shared/plugin-types';

describe('manifest-validator', () => {
  const validManifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.5 },
    scope: 'project',
    permissions: ['files'],
    contributes: { help: {} },
  };

  describe('SUPPORTED_API_VERSIONS', () => {
    it('includes version 0.5', () => {
      expect(SUPPORTED_API_VERSIONS).toContain(0.5);
    });

    it('does not include version 0.4', () => {
      expect(SUPPORTED_API_VERSIONS).not.toContain(0.4);
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

    // --- v0.5 help validation ---

    it('rejects v0.5 manifest without contributes.help', () => {
      const result = validateManifest({
        ...validManifest,
        contributes: {},
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('contributes.help');
    });

    it('accepts v0.5 manifest with contributes.help: {}', () => {
      const result = validateManifest({
        ...validManifest,
        contributes: { help: {} },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts v0.5 manifest with valid help topics', () => {
      const result = validateManifest({
        ...validManifest,
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

    it('rejects v0.5 manifest with malformed help topics', () => {
      const result = validateManifest({
        ...validManifest,
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

    it('rejects v0.5 manifest with no contributes at all', () => {
      const result = validateManifest({
        ...validManifest,
        contributes: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('contributes.help');
    });
  });

  // --- v0.5 permission validation ---

  describe('v0.5 permission validation', () => {
    const v05Base = {
      ...validManifest,
      engine: { api: 0.5 },
      permissions: ['files', 'git'],
    };

    it('0.5 is in SUPPORTED_API_VERSIONS', () => {
      expect(SUPPORTED_API_VERSIONS).toContain(0.5);
    });

    it('rejects v0.5 without permissions array', () => {
      const { permissions, ...rest } = v05Base;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('permissions array');
    });

    it('accepts v0.5 with empty permissions array', () => {
      const result = validateManifest({ ...v05Base, permissions: [] });
      expect(result.valid).toBe(true);
    });

    it('accepts v0.5 with valid permissions', () => {
      const result = validateManifest(v05Base);
      expect(result.valid).toBe(true);
    });

    it('rejects unknown permission strings', () => {
      const result = validateManifest({ ...v05Base, permissions: ['files', 'teleport'] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('unknown permission "teleport"');
    });

    it('rejects duplicate permissions', () => {
      const result = validateManifest({ ...v05Base, permissions: ['files', 'git', 'files'] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('duplicate permission "files"');
    });

    it('rejects non-string permission entries', () => {
      const result = validateManifest({ ...v05Base, permissions: ['files', 42] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must be a string');
    });

    it('rejects externalRoots without files.external permission', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files'],
        externalRoots: [{ settingKey: 'data-root', root: 'data' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires the "files.external" permission');
    });

    it('rejects files.external without externalRoots', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'files.external'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires at least one externalRoots entry');
    });

    it('accepts files.external with valid externalRoots', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'files.external'],
        externalRoots: [{ settingKey: 'data-root', root: 'data' }],
      });
      expect(result.valid).toBe(true);
    });

    it('validates externalRoots entry shape — missing settingKey', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'files.external'],
        externalRoots: [{ root: 'data' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('settingKey'))).toBe(true);
    });

    it('validates externalRoots entry shape — missing root', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'files.external'],
        externalRoots: [{ settingKey: 'data-root' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('root'))).toBe(true);
    });

    it('validates externalRoots entry shape — empty strings', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'files.external'],
        externalRoots: [{ settingKey: '', root: '' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    // --- allowedCommands / process permission validation ---

    it('rejects process permission without allowedCommands', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires at least one allowedCommands entry');
    });

    it('rejects allowedCommands without process permission', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files'],
        allowedCommands: ['gh'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires the "process" permission');
    });

    it('accepts process permission with valid allowedCommands', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: ['gh'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects allowedCommands entries with forward slash', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: ['/usr/bin/gh'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('path separators'))).toBe(true);
    });

    it('rejects allowedCommands entries with backslash', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: ['bin\\gh'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('path separators'))).toBe(true);
    });

    it('rejects allowedCommands entries with dot-dot', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: ['..gh'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('path separators'))).toBe(true);
    });

    it('rejects empty string in allowedCommands', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: [''],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('non-empty string'))).toBe(true);
    });

    it('accepts multiple valid allowedCommands', () => {
      const result = validateManifest({
        ...v05Base,
        permissions: ['files', 'process'],
        allowedCommands: ['gh', 'node', 'npx'],
      });
      expect(result.valid).toBe(true);
    });
  });

  // --- v0.6 validation ---

  describe('v0.6 API version', () => {
    const v06Base = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      engine: { api: 0.6 },
      scope: 'project' as const,
      permissions: ['commands'],
      contributes: { help: {} },
    };

    it('0.6 is in SUPPORTED_API_VERSIONS', () => {
      expect(SUPPORTED_API_VERSIONS).toContain(0.6);
    });

    it('accepts v0.6 manifest', () => {
      const result = validateManifest(v06Base);
      expect(result.valid).toBe(true);
    });

    it('v0.5 manifests still work', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.5 },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts commands with defaultBinding on v0.6', () => {
      const result = validateManifest({
        ...v06Base,
        contributes: {
          help: {},
          commands: [
            { id: 'run', title: 'Run', defaultBinding: 'Meta+Shift+R' },
          ],
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects defaultBinding on v0.5', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.5 },
        permissions: ['commands'],
        contributes: {
          help: {},
          commands: [
            { id: 'run', title: 'Run', defaultBinding: 'Meta+Shift+R' },
          ],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires API >= 0.6');
    });

    it('rejects non-string defaultBinding', () => {
      const result = validateManifest({
        ...v06Base,
        contributes: {
          help: {},
          commands: [
            { id: 'run', title: 'Run', defaultBinding: 42 },
          ],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('defaultBinding must be a string');
    });

    it('rejects non-boolean global flag', () => {
      const result = validateManifest({
        ...v06Base,
        contributes: {
          help: {},
          commands: [
            { id: 'run', title: 'Run', global: 'yes' },
          ],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('global must be a boolean');
    });

    it('accepts boolean global flag', () => {
      const result = validateManifest({
        ...v06Base,
        contributes: {
          help: {},
          commands: [
            { id: 'run', title: 'Run', global: true },
          ],
        },
      });
      expect(result.valid).toBe(true);
    });
  });

  // --- v0.6 agent-config permission validation ---

  describe('v0.6 agent-config permissions', () => {
    const v06Base = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      engine: { api: 0.6 },
      scope: 'project' as const,
      contributes: { help: {} },
    };

    it('accepts agent-config permission', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts agent-config with agent-config.permissions', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config', 'agent-config.permissions'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts agent-config with agent-config.mcp', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config', 'agent-config.mcp'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects agent-config.permissions without base agent-config', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config.permissions'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires the base "agent-config" permission');
    });

    it('rejects agent-config.mcp without base agent-config', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config.mcp'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires the base "agent-config" permission');
    });

    it('accepts all agent-config permissions together', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config', 'agent-config.cross-project', 'agent-config.permissions', 'agent-config.mcp'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts agent-config with agent-config.cross-project', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config', 'agent-config.cross-project'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects agent-config.cross-project without base agent-config', () => {
      const result = validateManifest({
        ...v06Base,
        permissions: ['agent-config.cross-project'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('requires the base "agent-config" permission');
    });
  });

  // --- v0.7 pack plugins ---

  describe('v0.7 pack plugins', () => {
    const validPack = {
      id: 'spring-themes',
      name: 'Spring Themes',
      version: '0.1.0',
      engine: { api: 0.7 },
      kind: 'pack',
      scope: 'app',
      contributes: {
        themes: [
          {
            id: 'cherry-blossom',
            name: 'Cherry Blossom',
            type: 'light',
            colors: { base: '#fff' },
            hljs: { keyword: '#f00' },
            terminal: { background: '#fff' },
          },
        ],
      },
    };

    it('0.7 is in SUPPORTED_API_VERSIONS', () => {
      expect(SUPPORTED_API_VERSIONS).toContain(0.7);
    });

    it('accepts a valid pack manifest', () => {
      const result = validateManifest(validPack);
      expect(result.valid).toBe(true);
    });

    it('pack plugins do not require permissions array', () => {
      const result = validateManifest(validPack);
      expect(result.valid).toBe(true);
      // No permission-related errors
      expect(result.errors.filter((e: string) => e.includes('permissions'))).toHaveLength(0);
    });

    it('pack plugins do not require contributes.help', () => {
      const result = validateManifest(validPack);
      expect(result.valid).toBe(true);
      expect(result.errors.filter((e: string) => e.includes('help'))).toHaveLength(0);
    });

    it('rejects pack with API < 0.7', () => {
      const result = validateManifest({ ...validPack, engine: { api: 0.6 } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Pack plugins require API >= 0.7'))).toBe(true);
    });

    it('rejects pack with main entry', () => {
      const result = validateManifest({ ...validPack, main: 'main.js' });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('must not specify a "main" entry'))).toBe(true);
    });

    it('rejects pack with settingsPanel', () => {
      const result = validateManifest({ ...validPack, settingsPanel: 'declarative' });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('must not specify a "settingsPanel"'))).toBe(true);
    });

    it('rejects pack with tab contribution', () => {
      const result = validateManifest({
        ...validPack,
        contributes: { ...validPack.contributes, tab: { label: 'Tab' } },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('cannot contribute a tab'))).toBe(true);
    });

    it('rejects pack with railItem contribution', () => {
      const result = validateManifest({
        ...validPack,
        contributes: { ...validPack.contributes, railItem: { label: 'Rail' } },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('cannot contribute a railItem'))).toBe(true);
    });

    it('rejects pack without any pack contribution', () => {
      const result = validateManifest({
        ...validPack,
        contributes: {},
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('must contribute at least one of'))).toBe(true);
    });

    it('rejects pack without contributes object', () => {
      const { contributes: _contributes, ...rest } = validPack;
      const result = validateManifest(rest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('must contribute at least one of'))).toBe(true);
    });

    it('rejects invalid kind value', () => {
      const result = validateManifest({ ...validPack, kind: 'addon' });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Invalid kind'))).toBe(true);
    });

    it('accepts kind: "plugin" explicitly', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.7 },
        kind: 'plugin',
      });
      expect(result.valid).toBe(true);
    });
  });

  // --- v0.7 contributes.themes validation ---

  describe('v0.7 contributes.themes', () => {
    const v07Base = {
      id: 'theme-plugin',
      name: 'Theme Plugin',
      version: '1.0.0',
      engine: { api: 0.7 },
      scope: 'app',
      permissions: [],
      contributes: { help: {} },
    };

    it('rejects contributes.themes on API < 0.7', () => {
      const result = validateManifest({
        ...validManifest,
        engine: { api: 0.6 },
        contributes: {
          help: {},
          themes: [{ id: 'test', name: 'Test', type: 'dark', colors: {}, hljs: {}, terminal: {} }],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('requires API >= 0.7'))).toBe(true);
    });

    it('rejects non-array contributes.themes', () => {
      const result = validateManifest({
        ...v07Base,
        contributes: { help: {}, themes: 'bad' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('must be an array'))).toBe(true);
    });

    it('validates theme entries have required fields', () => {
      const result = validateManifest({
        ...v07Base,
        contributes: {
          help: {},
          themes: [{ id: '', name: '', type: 'invalid', colors: null, hljs: null, terminal: null }],
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('themes[0].id'))).toBe(true);
      expect(result.errors.some((e: string) => e.includes('themes[0].name'))).toBe(true);
      expect(result.errors.some((e: string) => e.includes('themes[0].type'))).toBe(true);
    });

    it('accepts valid contributes.themes', () => {
      const result = validateManifest({
        ...v07Base,
        contributes: {
          help: {},
          themes: [{
            id: 'my-theme',
            name: 'My Theme',
            type: 'dark',
            colors: { base: '#1e1e2e' },
            hljs: { keyword: '#ff0000' },
            terminal: { background: '#1e1e2e' },
          }],
        },
      });
      expect(result.valid).toBe(true);
    });
  });

  // --- hierarchy-driven validation ---

  describe('PERMISSION_HIERARCHY enforcement', () => {
    const base = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      engine: { api: 0.5 },
      scope: 'project' as const,
      contributes: { help: {} },
    };

    it('rejects every child permission when its parent is missing', () => {
      for (const [child, parent] of Object.entries(PERMISSION_HIERARCHY)) {
        // Build a permissions array with the child but not the parent
        // Skip files.external which also needs externalRoots
        if (child === 'files.external') continue;
        const result = validateManifest({
          ...base,
          permissions: [child],
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e: string) => e.includes(`"${child}"`) && e.includes(`"${parent}"`))).toBe(true);
      }
    });

    it('accepts every child permission when its parent is present', () => {
      for (const [child, parent] of Object.entries(PERMISSION_HIERARCHY)) {
        // files.external also needs externalRoots
        if (child === 'files.external') continue;
        const result = validateManifest({
          ...base,
          permissions: [parent, child],
        });
        // Should not have hierarchy errors (may have other unrelated errors like process needing allowedCommands)
        const hierarchyErrors = result.errors.filter((e: string) => e.includes('requires the base'));
        expect(hierarchyErrors).toHaveLength(0);
      }
    });
  });
});
