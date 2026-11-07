/**
 * scripts/sync-builtin-text.mjs (#2902): syncs the built-in blocks and
 * templates from an export of the maintainer's builder. Check mode reports
 * what differs and writes nothing; --write updates builtin-text/.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_TEXT, BUILTIN_TEXT } from '../src/main/services/managed-agents/builtin-text/index';
import committedManifest from '../src/main/services/managed-agents/builtin-text/manifest.json';

type Doc = Record<string, unknown>;

let root: string;
let exportDir: string;
let textDir: string;

function writeDoc(kind: 'blocks' | 'skills' | 'templates', doc: Doc, wrap = false): void {
  const dir = path.join(exportDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${String(doc.id)}.json`), JSON.stringify(wrap ? { data: doc } : doc));
}

const block = (id: string, over: Doc = {}): Doc => ({ id, name: id, description: `${id} description`, text: `${id} text`, status: 'ok', order: 0, origin: 'builtin', ...over });
const skillMd = (name: string, description = `Use when you need ${name}.`, body = `# ${name}\n\nDo ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
/** A skill whose folder (front matter name) is its slug, and whose library name is `Slug skill`. */
const skill = (slug: string, over: Doc = {}): Doc => ({ id: `builtin-skill-${slug}`, name: `${slug} skill`, text: skillMd(slug), status: 'ok', order: 0, origin: 'builtin', ...over });
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

  it('writes each skill\'s SKILL.md as it is, and takes template skills from the export (#2902)', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    const validateMd = skillMd('validate', '"Check a change: build, test and lint."');
    writeDoc('skills', skill('validate', { text: `${validateMd}\n\n\n`, order: 1 }));
    writeDoc('skills', skill('build', { order: 0 }), true);
    writeDoc('skills', skill('scrapped', { status: 'cut', origin: 'new' }));
    writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity'], { name: 'Orchestrator', order: 0, skills: ['builtin-skill-build', 'builtin-skill-validate'] }));
    const written = syncBuiltinText(exportDir, { textDir, write: true });
    expect(written).toMatchObject({ problems: [], written: true });
    expect(syncBuiltinText(exportDir, { textDir })).toMatchObject({ problems: [], differences: [] });
    // Exactly as it is.
    expect(readFileSync(path.join(textDir, 'skills', 'validate', 'SKILL.md'), 'utf8')).toBe(`${validateMd}\n\n\n`);
    expect(existsSync(path.join(textDir, 'skills', 'scrapped'))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(textDir, 'manifest.json'), 'utf8'));
    expect(manifest.skills).toEqual([
      { id: 'builtin-skill-build', name: 'build skill', skillName: 'build', description: 'Use when you need build.', file: 'skills/build/SKILL.md' },
      // The folder and description are the front matter's, which the CLI sees; the name is the library's.
      { id: 'builtin-skill-validate', name: 'validate skill', skillName: 'validate', description: 'Check a change: build, test and lint.', file: 'skills/validate/SKILL.md' },
    ]);
    expect(manifest.templates[0].skills).toEqual(['builtin-skill-build', 'builtin-skill-validate']);
    expect(manifest.templates[1].skills).toBeUndefined();
    const index = readFileSync(path.join(textDir, 'index.ts'), 'utf8');
    expect(index).toContain("import validateSkillText from './skills/validate/SKILL.md';");
    expect(index).toContain("'skills/validate/SKILL.md': validateSkillText,");

    // A template with no skills field (an older export) keeps the manifest's.
    writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity'], { name: 'Orchestrator', order: 0 }));
    expect(syncBuiltinText(exportDir, { textDir })).toMatchObject({ problems: [], differences: [] });
    // One that gives skills wins.
    writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity'], { name: 'Orchestrator', order: 0, skills: ['builtin-skill-validate'] }));
    expect(syncBuiltinText(exportDir, { textDir }).differences).toEqual([
      'template builtin-template-orchestrator: skills ["builtin-skill-build","builtin-skill-validate"] -> ["builtin-skill-validate"]',
    ]);

    // A skill dropped from the export is a problem; one that's cut keeps its shipped file.
    rmSync(path.join(exportDir, 'skills', 'builtin-skill-build.json'));
    expect(syncBuiltinText(exportDir, { textDir }).problems).toEqual(expect.arrayContaining([
      'skill builtin-skill-build is built in but missing from the export; built-in ids never disappear',
    ]));
    writeDoc('skills', skill('build', { status: 'cut', text: 'gone' }));
    const cut = syncBuiltinText(exportDir, { textDir, write: true });
    expect(cut.problems).toEqual([]);
    expect(cut.manifest.skills[0]).toEqual({ id: 'builtin-skill-build', name: 'build skill', skillName: 'build', description: 'Use when you need build.', file: 'skills/build/SKILL.md', retired: true });
    expect(readFileSync(path.join(textDir, 'skills', 'build', 'SKILL.md'), 'utf8')).toBe(skillMd('build'));
  });

  it('lets variants share a folder, stored by id, but never two of them in one template (#2902)', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    writeDoc('skills', skill('post-result', { name: 'Post result', order: 0 }));
    writeDoc('skills', skill('post-result-pr', { name: 'Post result to pull request', text: skillMd('post-result', 'Use on a pull request.'), order: 1 }));
    writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity'], { name: 'Orchestrator', order: 0, skills: ['builtin-skill-post-result-pr'] }));
    expect(syncBuiltinText(exportDir, { textDir, write: true })).toMatchObject({ problems: [], written: true });
    expect(readFileSync(path.join(textDir, 'skills', 'post-result-pr', 'SKILL.md'), 'utf8')).toBe(skillMd('post-result', 'Use on a pull request.'));
    const manifest = JSON.parse(readFileSync(path.join(textDir, 'manifest.json'), 'utf8'));
    expect(manifest.skills.map((sk: { skillName: string; file: string }) => [sk.skillName, sk.file])).toEqual([
      ['post-result', 'skills/post-result/SKILL.md'], ['post-result', 'skills/post-result-pr/SKILL.md'],
    ]);
    expect(readFileSync(path.join(textDir, 'index.ts'), 'utf8')).toContain("import postResultPrSkillText from './skills/post-result-pr/SKILL.md';");

    writeDoc('templates', template('builtin-template-orchestrator', ['builtin-block-identity'], { name: 'Orchestrator', order: 0, skills: ['builtin-skill-post-result', 'builtin-skill-post-result-pr'] }));
    writeDoc('skills', skill('other', { name: 'Post result' }));
    expect(syncBuiltinText(exportDir, { textDir, write: true })).toMatchObject({
      written: false,
      problems: [
        'skill builtin-skill-post-result: another skill is named "Post result"',
        'template builtin-template-orchestrator: lists builtin-skill-post-result and builtin-skill-post-result-pr, which both install as post-result/',
      ],
    });
  });

  it('refuses a skill without valid front matter, a bad folder name, a wildcard or an unknown template skill (#2902)', async () => {
    const { syncBuiltinText } = await import('./sync-builtin-text.mjs');
    syncBuiltinText(exportDir, { textDir, write: true });
    const before = readFileSync(path.join(textDir, 'manifest.json'), 'utf8');
    writeDoc('skills', skill('bare', { text: '# Bare\n\nNo front matter.' }));
    writeDoc('skills', skill('quiet', { text: '---\nname: quiet\ndescription:\n---\n\n# Quiet' }));
    writeDoc('skills', skill('nameless', { text: '---\ndescription: Use it.\n---\n\n# x' }));
    writeDoc('skills', skill('folded', { text: '---\nname: folded\ndescription: >\n  Long.\n---\n\n# x' }));
    writeDoc('skills', skill('wild', { text: skillMd('wild', undefined, 'Run @@BuildCommand.') }));
    writeDoc('skills', skill('badname', { text: skillMd('Bad Name') }));
    writeDoc('skills', skill('doubled', { text: skillMd('post--result') }));
    writeDoc('skills', skill('trailing', { text: skillMd('result-') }));
    writeDoc('skills', skill('vendor', { text: skillMd('claude-helper') }));
    writeDoc('skills', skill('extra', { text: '---\nname: extra\ndescription: Use it.\nlicense: MIT\n---\n\n# x' }));
    writeDoc('skills', skill('long', { text: skillMd('long', `Use it ${'x'.repeat(500)}`) }));
    writeDoc('skills', skill('moved', { folder: 'elsewhere' }));
    writeDoc('skills', skill('Bad_Id'));
    writeDoc('templates', template('builtin-template-group', ['builtin-block-identity'], { name: 'Group', order: 1, skills: ['builtin-skill-nope'] }));
    const r = syncBuiltinText(exportDir, { textDir, write: true });
    expect(r.written).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([
      'skill builtin-skill-bare: doesn\'t start with front matter (--- name and description ---)',
      'skill builtin-skill-quiet: front matter description is empty; the CLI uses it to decide when to load the skill',
      'skill builtin-skill-nameless: front matter has no name',
      'skill builtin-skill-folded: front matter line "Long." isn\'t a one-line key: value',
      'skill builtin-skill-doubled: front matter name "post--result" must be 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
      'skill builtin-skill-trailing: front matter name "result-" must be 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
      'skill builtin-skill-vendor: front matter name "claude-helper" can\'t contain "claude" or "anthropic"',
      'skill builtin-skill-extra: front matter has license; only name and description are allowed',
      'skill builtin-skill-long: front matter description has 507 characters; the most is 500',
      'skill builtin-skill-moved: front matter name "moved" isn\'t its folder "elsewhere"',
      'skill builtin-skill-wild: uses @@BuildCommand, which skills don\'t fill in',
      'skill builtin-skill-badname: front matter name "Bad Name" must be 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
      'skill builtin-skill-Bad_Id: "builtin-skill-Bad_Id" isn\'t a built-in skill id (builtin-skill- and lowercase letters, digits and dashes)',
      'template builtin-template-group: lists unknown skill builtin-skill-nope',
    ]));
    expect(readFileSync(path.join(textDir, 'manifest.json'), 'utf8')).toBe(before);
    expect(existsSync(path.join(textDir, 'skills'))).toBe(false);
  });

  it('the committed built-in text matches its own manifest exactly', async () => {
    const { DEFAULT_TEXT_DIR, syncBuiltinText } = await import('./sync-builtin-text.mjs');
    // Rebuild an export from what the app bundles; a sync of it must find nothing to change.
    rmSync(exportDir, { recursive: true });
    committedManifest.blocks.forEach((b: { id: string; name: string; description: string; file: string; retired?: boolean }, order: number) => writeDoc('blocks', {
      id: b.id, name: b.name, description: b.description, order, origin: 'builtin', status: b.retired ? 'cut' : 'ok', text: BUILTIN_TEXT[b.file],
    }));
    (committedManifest.skills as Array<{ id: string; name: string; skillName: string; description: string; file: string; retired?: boolean }>).forEach((sk, order) => writeDoc('skills', {
      id: sk.id, name: sk.name, description: sk.description, order, origin: 'builtin', status: sk.retired ? 'cut' : 'ok', text: BUILTIN_SKILL_TEXT[sk.file],
    }));
    (committedManifest.templates as Array<{ id: string; name: string; description: string; blocks: string[]; skills?: string[]; settings: { orchestration?: Doc } & Doc; retired?: boolean }>).forEach((t, order) => {
      const { orchestration, ...rest } = t.settings;
      writeDoc('templates', { id: t.id, name: t.name, description: t.description, blocks: t.blocks, skills: t.skills ?? [], settings: { ...rest, ...orchestration }, order, origin: 'builtin', status: t.retired ? 'cut' : 'ok' });
    });
    expect(syncBuiltinText(exportDir, { textDir: DEFAULT_TEXT_DIR })).toMatchObject({ problems: [], differences: [] });
  });
});
