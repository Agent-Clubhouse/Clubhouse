import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest-validator';

/** Minimal valid manifest for API 0.9 */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.9 },
    scope: 'project',
    permissions: ['files'],
    contributes: {
      help: { topics: [{ id: 'intro', title: 'Intro', content: 'Help text' }] },
      tab: { title: 'Test' },
    },
    ...overrides,
  };
}

describe('validateManifest', () => {
  // --- Core validation ---

  it('accepts a minimal valid manifest', () => {
    const result = validateManifest(validManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest('string').valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
    expect(validateManifest(undefined).valid).toBe(false);
  });

  // --- Required fields ---

  it('requires id as non-empty string', () => {
    const r = validateManifest(validManifest({ id: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(expect.stringContaining('id'));
  });

  it('rejects invalid id format', () => {
    const r = validateManifest(validManifest({ id: 'UPPER_CASE' }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(expect.stringContaining('must match'));
  });

  it('requires name', () => {
    const r = validateManifest(validManifest({ name: '' }));
    expect(r.errors).toContainEqual(expect.stringContaining('name'));
  });

  it('requires version', () => {
    const r = validateManifest(validManifest({ version: '' }));
    expect(r.errors).toContainEqual(expect.stringContaining('version'));
  });

  // --- Engine / API version ---

  it('requires engine object', () => {
    const r = validateManifest(validManifest({ engine: undefined }));
    expect(r.errors).toContainEqual(expect.stringContaining('engine'));
  });

  it('requires engine.api to be a number', () => {
    const r = validateManifest(validManifest({ engine: { api: 'bad' } }));
    expect(r.errors).toContainEqual(expect.stringContaining('engine.api must be a number'));
  });

  it('rejects unsupported API versions', () => {
    const r = validateManifest(validManifest({ engine: { api: 99.9 } }));
    expect(r.errors).toContainEqual(expect.stringContaining('not supported'));
  });

  // --- Scope ---

  it('rejects invalid scope', () => {
    const r = validateManifest(validManifest({ scope: 'invalid' }));
    expect(r.errors).toContainEqual(expect.stringContaining('Invalid scope'));
  });

  it('rejects project-scoped plugin with railItem', () => {
    const m = validManifest({ scope: 'project', contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, railItem: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Project-scoped plugins cannot contribute railItem'));
  });

  it('rejects app-scoped plugin with tab', () => {
    const m = validManifest({ scope: 'app', contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('App-scoped plugins cannot contribute tab'));
  });

  // --- Kind: pack ---

  it('rejects pack with main entry', () => {
    const m = validManifest({ kind: 'pack', main: 'index.js', scope: 'app', contributes: { themes: [{}] } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must not specify a "main"'));
  });

  it('rejects pack with settingsPanel', () => {
    const m = validManifest({ kind: 'pack', settingsPanel: true, scope: 'app', contributes: { themes: [{}] } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must not specify a "settingsPanel"'));
  });

  it('rejects pack with tab/railItem/globalDialog', () => {
    const m = validManifest({ kind: 'pack', scope: 'app', contributes: { themes: [{}], tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Pack plugins cannot contribute a tab'));
  });

  it('requires pack to have at least one pack contribution', () => {
    const m = validManifest({ kind: 'pack', scope: 'app', contributes: {} });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must contribute at least one of'));
  });

  it('rejects pack with API < 0.7', () => {
    const m = validManifest({ kind: 'pack', engine: { api: 0.6 } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Pack plugins require API >= 0.7'));
  });

  // --- Kind: workspace ---

  it('rejects workspace with API < 0.9', () => {
    const m = validManifest({ kind: 'workspace', engine: { api: 0.8 } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Workspace plugins require API >= 0.9'));
  });

  it('requires workspace plugins to be app-scoped', () => {
    const m = validManifest({ kind: 'workspace', scope: 'project', permissions: ['files', 'companion'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must be app-scoped'));
  });

  it('requires workspace plugins to have companion permission', () => {
    const m = validManifest({ kind: 'workspace', scope: 'app', permissions: ['files'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('require the "companion" permission'));
  });

  // --- Help topics (v0.5+) ---

  it('requires help for non-pack API >= 0.5', () => {
    const m = validManifest({ contributes: {} });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must include contributes.help'));
  });

  it('validates help topic fields', () => {
    const m = validManifest({
      contributes: {
        help: { topics: [{ id: '', title: '', content: '' }] },
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('topics[0].id must be a non-empty string'));
    expect(r.errors).toContainEqual(expect.stringContaining('topics[0].title must be a non-empty string'));
    expect(r.errors).toContainEqual(expect.stringContaining('topics[0].content must be a non-empty string'));
  });

  // --- Permissions ---

  it('requires permissions array for non-pack API >= 0.5', () => {
    const m = validManifest({ permissions: undefined });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must include a permissions array'));
  });

  it('rejects unknown permissions', () => {
    const m = validManifest({ permissions: ['files', 'unknown-perm'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('unknown permission'));
  });

  it('rejects duplicate permissions', () => {
    const m = validManifest({ permissions: ['files', 'files'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('duplicate permission'));
  });

  it('requires parent permission when child is present', () => {
    const m = validManifest({ permissions: ['files.external'], externalRoots: [{ settingKey: 'k', root: '/r' }] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('requires the base "files" permission'));
  });

  // --- ExternalRoots / files.external ---

  it('requires files.external permission for externalRoots', () => {
    const m = validManifest({ permissions: ['files'], externalRoots: [{ settingKey: 'k', root: '/r' }] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('requires the "files.external" permission'));
  });

  it('requires externalRoots when files.external is set', () => {
    const m = validManifest({ permissions: ['files', 'files.external'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('requires at least one externalRoots entry'));
  });

  it('validates externalRoots entries', () => {
    const m = validManifest({
      permissions: ['files', 'files.external'],
      externalRoots: [{ settingKey: '', root: '' }],
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('settingKey must be a non-empty string'));
    expect(r.errors).toContainEqual(expect.stringContaining('root must be a non-empty string'));
  });

  // --- AllowedCommands / process ---

  it('requires allowedCommands when process permission is set', () => {
    const m = validManifest({ permissions: ['files', 'process'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('"process" permission requires'));
  });

  it('rejects commands with path separators', () => {
    const m = validManifest({ permissions: ['files', 'process'], allowedCommands: ['/usr/bin/git'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('must not contain path separators'));
  });

  // --- API-gated permissions ---

  it('rejects canvas permission below API 0.8', () => {
    const m = validManifest({ engine: { api: 0.7 }, permissions: ['files', 'canvas'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Canvas permission requires API >= 0.8'));
  });

  it('rejects annex permission below API 0.8', () => {
    const m = validManifest({ engine: { api: 0.7 }, permissions: ['files', 'annex'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Annex permission requires API >= 0.8'));
  });

  it('rejects companion permission below API 0.9', () => {
    const m = validManifest({ engine: { api: 0.8 }, permissions: ['files', 'companion'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('Companion permission requires API >= 0.9'));
  });

  it('rejects mcp.tools permission below API 0.9', () => {
    const m = validManifest({ engine: { api: 0.8 }, permissions: ['files', 'mcp.tools'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('mcp.tools permission requires API >= 0.9'));
  });

  // --- Commands ---

  it('rejects defaultBinding below API 0.6', () => {
    const m = validManifest({
      engine: { api: 0.5 },
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        commands: [{ id: 'cmd', defaultBinding: 'ctrl+k' }],
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('defaultBinding requires API >= 0.6'));
  });

  it('rejects non-boolean global in commands', () => {
    const m = validManifest({
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        commands: [{ id: 'cmd', global: 'yes' }],
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('global must be a boolean'));
  });

  // --- Themes (v0.7+) ---

  it('rejects themes below API 0.7', () => {
    const m = validManifest({ engine: { api: 0.6 }, contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, themes: [], tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('contributes.themes requires API >= 0.7'));
  });

  it('validates theme required fields', () => {
    const m = validManifest({
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        themes: [{ id: '', name: '', type: 'invalid' }],
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('themes[0].id must be a non-empty string'));
    expect(r.errors).toContainEqual(expect.stringContaining('themes[0].name must be a non-empty string'));
    expect(r.errors).toContainEqual(expect.stringContaining('themes[0].type must be "dark" or "light"'));
  });

  // --- AgentConfig (v0.7+) ---

  it('rejects agentConfig below API 0.7', () => {
    const m = validManifest({ engine: { api: 0.6 }, contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, agentConfig: {}, tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('contributes.agentConfig requires API >= 0.7'));
  });

  // --- GlobalDialog (v0.7+) ---

  it('rejects globalDialog below API 0.7', () => {
    const m = validManifest({ engine: { api: 0.6 }, contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, globalDialog: { label: 'Test' }, tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('contributes.globalDialog requires API >= 0.7'));
  });

  it('requires globalDialog label', () => {
    const m = validManifest({
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        globalDialog: { label: '' },
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('globalDialog.label must be a non-empty string'));
  });

  // --- CanvasWidgets (v0.8+) ---

  it('rejects canvasWidgets below API 0.8', () => {
    const m = validManifest({ engine: { api: 0.7 }, contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, canvasWidgets: [], tab: {} } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('contributes.canvasWidgets requires API >= 0.8'));
  });

  it('rejects duplicate canvasWidget ids', () => {
    const m = validManifest({
      permissions: ['files', 'canvas'],
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        canvasWidgets: [
          { id: 'w1', label: 'W1' },
          { id: 'w1', label: 'W1 dup' },
        ],
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('duplicate'));
  });

  it('requires canvas permission for canvasWidgets', () => {
    const m = validManifest({
      permissions: ['files'],
      contributes: {
        help: { topics: [{ id: 'a', title: 'A', content: 'c' }] },
        canvasWidgets: [{ id: 'w1', label: 'W1' }],
        tab: {},
      },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('requires the "canvas" permission'));
  });

  // --- Companion config (v0.9+) ---

  it('rejects companion config below API 0.9', () => {
    const m = validManifest({ engine: { api: 0.8 }, companion: { enabled: true } });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('companion config requires API >= 0.9'));
  });

  it('requires companion.enabled to be boolean', () => {
    const m = validManifest({ companion: { enabled: 'yes' }, permissions: ['files', 'companion'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('companion.enabled must be a boolean'));
  });

  it('requires companion permission for companion config', () => {
    const m = validManifest({ companion: { enabled: true }, permissions: ['files'] });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('companion config requires the "companion" permission'));
  });

  // --- Tab/RailItem title (v0.8+) ---

  it('rejects tab.title below API 0.8', () => {
    const m = validManifest({
      engine: { api: 0.7 },
      contributes: { help: { topics: [{ id: 'a', title: 'A', content: 'c' }] }, tab: { title: 'T' } },
    });
    const r = validateManifest(m);
    expect(r.errors).toContainEqual(expect.stringContaining('contributes.tab.title requires API >= 0.8'));
  });
});
