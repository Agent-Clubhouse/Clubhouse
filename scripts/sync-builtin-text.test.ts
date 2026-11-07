/**
 * scripts/sync-builtin-text.mjs (#2902): syncs the built-in blocks and
 * templates from an export of the maintainer's builder. Check mode reports
 * what differs and writes nothing; --write updates builtin-text/.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEXT } from '../src/main/services/managed-agents/builtin-text/index';
import committedManifest from '../src/main/services/managed-agents/builtin-text/manifest.json';

type Doc = Record<string, unknown>;

let root: string;
let exportDir: string;
let textDir: string;

function writeDoc(kind: 'blocks' | 'templates', doc: Doc, wrap = false): void {
  const dir = path.join(exportDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${String(doc.id)}.json`), JSON.stringify(wrap ? { data: doc } : doc));
}

const block = (id: string, over: Doc = {}): Doc => ({ id, name: id, description: `${id} description`, text: `${id} text`, status: 'ok', order: 0, origin: 'builtin', ...over });
const template = (id: string, blocks: string[], over: Doc = {}): Doc => ({ id, name: id, description: '', blocks, settings: {}, status: 'ok', order: 0, origin: 'builtin', ...over });

function baseExport(): void {
  writeDoc('blocks', block('builtin-block-identity', { name: 'Identity', text: 'You are @@AgentName, an agent working in Clubhouse.\n', order: 0 }));
  writeDoc('blocks', block('builtin-block-orchestrator', { name: 'Orchestrator', order: 2, status: 'unreviewed' }), true);
  writeDoc('blocks', block('custom-block-a3kvsk', { name: 'Group projects', order: 11, origin: 'new' }));
  writeDoc('blocks', block('builtin-block-project-manager', { name: 'Project manager', status: 'cut', order: 3 }));
  writeDoc('blocks', block('builtin-block-scrapped', { status: 'cut', order: 4, origin: 'new' }));
  writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity', 'builtin-block-orchestrator'], {
    name: 'Orchestrator', order: 0,
    settings: { orchestrate: true, maxHelpers: 5, autoHelpers: true, connectToDispatcher: true, freeAgentMode: true, model: 'opus' },
  }));
  writeDoc('templates', template('builtin-template-group', ['builtin-block-identity', 'custom-block-a3kvsk'], { name: 'Group', order: 1 }), true);
  writeDoc('templates', template('builtin-template-project-manager', ['builtin-block-identity', 'builtin-block-project-manager'], { name: 'Project Manager', status: 'cut', order: 2 }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sync-builtin-text-'));
  exportDir = path.join(root, 'export');
  textDir = path.join(root, 'builtin-text');
  mkdirSync(textDir, { recursive: true });
  // The cut block shipped before, so its text is already there.
  writeFileSync(path.join(textDir, 'project-manager.md'), 'Old PM text.\n');
  baseExport();
});

describe('sync-builtin-text', () => {
  it('writes the text, manifest and index from an export, then checks clean', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    const first = syncBuiltinText(exportDir, { textDir });
    expect(first.problems).toEqual([]);
    expect(first.written).toBe(false);
    expect(first.differences).toContain('manifest.json: missing');
    // Check mode writes nothing.
    expect(existsSync(path.join(textDir, 'manifest.json'))).toBe(false);

    const written = syncBuiltinText(exportDir, { textDir, write: true });
    expect(written.written).toBe(true);
    expect(syncBuiltinText(exportDir, { textDir })).toMatchObject({ problems: [], differences: [] });

    const manifest = JSON.parse(readFileSync(path.join(textDir, 'manifest.json'), 'utf8'));
    expect(manifest.blocks.map((b: { id: string }) => b.id)).toEqual([
      'builtin-block-identity', 'builtin-block-orchestrator', 'builtin-block-project-manager', 'builtin-block-group-projects',
    ]);
    expect(manifest.blocks[2]).toMatchObject({ file: 'project-manager.md', retired: true });
    expect(manifest.blocks[0].retired).toBeUndefined();
    expect(manifest.templates).toEqual([
      expect.objectContaining({
        id: 'builtin-template-orchestrator', blocks: ['builtin-block-identity', 'builtin-block-orchestrator'],
        settings: { model: 'opus', freeAgentMode: true, orchestration: { orchestrate: true, maxHelpers: 5, autoHelpers: true, connectToDispatcher: true } },
      }),
      expect.objectContaining({ id: 'builtin-template-group', blocks: ['builtin-block-identity', 'builtin-block-group-projects'], settings: {} }),
      expect.objectContaining({ id: 'builtin-template-project-manager', retired: true }),
    ]);
    expect(readFileSync(path.join(textDir, 'identity.md'), 'utf8')).toBe('You are @@AgentName, an agent working in Clubhouse.\n');
    expect(readFileSync(path.join(textDir, 'group-projects.md'), 'utf8')).toBe('custom-block-a3kvsk text\n');
    // A cut block keeps the text it shipped with; one that never shipped is dropped.
    expect(readFileSync(path.join(textDir, 'project-manager.md'), 'utf8')).toBe('Old PM text.\n');
    expect(existsSync(path.join(textDir, 'scrapped.md'))).toBe(false);
    const index = readFileSync(path.join(textDir, 'index.ts'), 'utf8');
    expect(index).toContain("import groupProjectsText from './group-projects.md';");
    expect(index).toContain("'project-manager.md': projectManagerText,");
  });

  it('check mode reports name, description, text, composition and settings changes without writing', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    syncBuiltinText(exportDir, { textDir, write: true });
    const before = readFileSync(path.join(textDir, 'manifest.json'), 'utf8');

    writeDoc('blocks', block('builtin-block-orchestrator', { name: 'Lead', description: 'Leads.', text: 'New words.', order: 2 }));
    writeDoc('templates', template('builtin-template-group', ['builtin-block-identity', 'custom-block-a3kvsk', 'builtin-block-orchestrator'], {
      name: 'Group', order: 1, settings: { maxHelpers: 2 },
    }));
    const r = syncBuiltinText(exportDir, { textDir });
    expect(r.problems).toEqual([]);
    expect(r.written).toBe(false);
    expect(r.differences).toEqual(expect.arrayContaining([
      'block builtin-block-orchestrator: name "Orchestrator" -> "Lead"',
      'block builtin-block-orchestrator: description "builtin-block-orchestrator description" -> "Leads."',
      'orchestrator.md: text differs',
      expect.stringMatching(/^template builtin-template-group: blocks /),
      'template builtin-template-group: settings {} -> {"orchestration":{"maxHelpers":2}}',
    ]));
    expect(readFileSync(path.join(textDir, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('reports problems and refuses to write them', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    syncBuiltinText(exportDir, { textDir, write: true });
    const before = readFileSync(path.join(textDir, 'manifest.json'), 'utf8');

    rmSync(path.join(exportDir, 'templates', 'builtin-template-project-manager.json'));
    writeDoc('templates', template('builtin-template-group', ['builtin-block-identity', 'builtin-block-project-manager', 'builtin-block-nope'], { settings: { colour: 'red', maxHelpers: 'lots' } }));
    writeDoc('blocks', block('custom-block-zzz'));
    const r = syncBuiltinText(exportDir, { textDir, write: true });
    expect(r.written).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([
      'template builtin-template-group: lists cut block builtin-block-project-manager',
      'template builtin-template-group: lists unknown block builtin-block-nope',
      'template builtin-template-group: unknown setting "colour"',
      'template builtin-template-group: setting "maxHelpers" has a bad value "lots"',
      'block custom-block-zzz: "custom-block-zzz" isn\'t a built-in id (add it to ID_MAP)',
      'template builtin-template-project-manager is built in but missing from the export; built-in ids never disappear',
    ]));
    expect(readFileSync(path.join(textDir, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('the committed built-in text matches its own manifest exactly', async () => {
    const { DEFAULT_TEXT_DIR, syncBuiltinText } = await import('./sync-builtin-text.mjs');
    // Rebuild an export from what the app bundles; a sync of it must find nothing to change.
    rmSync(exportDir, { recursive: true });
    committedManifest.blocks.forEach((b: { id: string; name: string; description: string; file: string; retired?: boolean }, order: number) => writeDoc('blocks', {
      id: b.id, name: b.name, description: b.description, order, origin: 'builtin', status: b.retired ? 'cut' : 'ok', text: BUILTIN_TEXT[b.file],
    }));
    (committedManifest.templates as Array<{ id: string; name: string; description: string; blocks: string[]; settings: { orchestration?: Doc } & Doc; retired?: boolean }>).forEach((t, order) => {
      const { orchestration, ...rest } = t.settings;
      writeDoc('templates', { id: t.id, name: t.name, description: t.description, blocks: t.blocks, settings: { ...rest, ...orchestration }, order, origin: 'builtin', status: t.retired ? 'cut' : 'ok' });
    });
    expect(syncBuiltinText(exportDir, { textDir: DEFAULT_TEXT_DIR })).toMatchObject({ problems: [], differences: [] });
  });
});
