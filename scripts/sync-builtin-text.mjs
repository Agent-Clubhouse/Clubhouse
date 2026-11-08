#!/usr/bin/env node
/**
 * Syncs Clubhouse's built-in agent parts and templates (#2902) from an export
 * of the maintainer's builder: one JSON file per document, in `blocks/`,
 * `skills/` and `templates/`, with the fields at the top level or under `data`.
 *
 *   node scripts/sync-builtin-text.mjs <export folder>           # check only
 *   node scripts/sync-builtin-text.mjs <export folder> --write   # update the files
 *
 * It owns everything in src/main/services/managed-agents/builtin-text/:
 *   - `<slug>.md`: each block's text, where the slug is the id without
 *     `builtin-block-`. A cut block's text is never written: it keeps the
 *     text it shipped with.
 *   - `skills/<slug>/SKILL.md`: each skill's text, written exactly as it is, where
 *     the slug is the id without `builtin-skill-`. The text is the whole
 *     SKILL.md: it must start with front matter whose `name` is the folder
 *     the CLI gets (lowercase letters, digits and dashes) and whose
 *     `description` isn't empty. The export's `name` is the library name.
 *     Variants can share a folder (the post-result skills all install as
 *     `post-result/`), so no template lists two skills with one folder.
 *     A cut skill keeps the file it shipped with, and so does a shipped
 *     skill the export no longer has: both become retired built-ins (D71).
 *   - `manifest.json`: block names, descriptions and files, skill names,
 *     folders, descriptions and files, and template names, descriptions,
 *     blocks, skills and settings, which builtins.ts reads.
 *   - `index.ts`: imports every block and skill file, so the bundle has the
 *     text.
 *
 * A template takes its skills from the export. One with no `skills` field (an
 * export from before the builder had skills) keeps the skills the manifest
 * gives it.
 *
 * Cut blocks and templates that shipped (origin "builtin") stay in the
 * manifest as retired built-ins: the app no longer installs them, and at its
 * next start whatever uses one switches to the person's own copy (D99). Cut documents that never shipped are dropped. Built-in ids
 * never disappear: an id in the manifest that's missing from the export is
 * a problem, not a removal.
 *
 * Check mode exits 1 when the files differ from the export or the export has
 * problems. --write refuses to write when the export has problems.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_TEXT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'services', 'managed-agents', 'builtin-text');

/**
 * The asset catalog's own checks (`validatePayload`, `nameIssues`,
 * `isAssetId`), loaded from its TypeScript source, so a sync refuses what
 * `ensureBuiltins` would refuse at startup: sizes, secrets, paths and the
 * rest. Vitest loads TypeScript itself; plain Node strips the types, and a
 * small resolve hook adds the `.ts` the source's imports leave out.
 */
async function loadCatalogChecks() {
  const source = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'services', 'asset-catalog', 'validation.ts')).href;
  if (!process.env.VITEST) {
    const hook = `export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); } catch (err) {
        if (/^\\.{1,2}\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
          for (const ext of ['.ts', '/index.ts']) { try { return await next(specifier + ext, context); } catch { /* next */ } }
        }
        throw err;
      }
    }
    // The source is ES modules without "type": "module"; saying so skips Node's guess and its warning.
    export async function load(url, context, next) {
      return next(url, url.endsWith('.ts') ? { ...context, format: 'module-typescript' } : context);
    }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`);
  }
  return import(source);
}

let catalogChecks = null;
let catalogChecksError = null;
try {
  catalogChecks = await loadCatalogChecks();
} catch (err) {
  catalogChecksError = err instanceof Error ? err.message : String(err);
}

/** What the catalog would refuse about one built-in, as problem text; empty when it takes it. */
function catalogProblems(where, kind, id, name, payload) {
  if (!catalogChecks) return [`${where}: the asset catalog's checks couldn't load (${catalogChecksError}), so nothing can be checked`];
  const issues = [...catalogChecks.nameIssues(name)];
  if (!catalogChecks.isAssetId(id)) issues.push({ code: 'invalid_identifier', path: 'id' });
  if (payload) {
    const checked = catalogChecks.validatePayload(kind, payload, true);
    if (checked.ok === false) issues.push(...checked.issues);
  }
  return issues.length === 0 ? [] : [`${where}: the asset catalog refuses it (${issues.map((i) => `${i.code} at ${i.path}`).join(', ')})`];
}

/** Line endings don't count as a difference: a Windows checkout may have turned them into CRLF. */
const lf = (text) => text.replace(/\r\n/g, '\n');

/** Builder ids that become a different built-in id. Applied to blocks and to template block lists. */
export const ID_MAP = { 'custom-block-a3kvsk': 'builtin-block-group-projects' };

const BLOCK_PREFIX = 'builtin-block-';
const SKILL_PREFIX = 'builtin-skill-';
/** The part of a built-in skill id after `builtin-skill-`, which names its file in `skills/`. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = new Set(['ok', 'work', 'unreviewed', 'cut']);
const ORCHESTRATION_KEYS = ['orchestrate', 'maxHelpers', 'autoHelpers', 'connectToDispatcher'];
const OTHER_SETTING_KEYS = ['orchestrator', 'model', 'freeAgentMode'];
const MANIFEST_COMMENT = 'Generated by scripts/sync-builtin-text.mjs from the maintainer\'s builder export. Change the export and sync; don\'t edit by hand.';

const mapId = (id) => ID_MAP[id] ?? id;
const readOr = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

function readDocs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const doc = raw && typeof raw.data === 'object' && raw.data !== null ? raw.data : raw;
    return { ...doc, file: f };
  });
}

/** Read an export folder: `{ blocks, templates }`, each document unwrapped from `data` when it has one. */
export function readExport(exportDir) {
  return {
    blocks: readDocs(path.join(exportDir, 'blocks')),
    skills: readDocs(path.join(exportDir, 'skills')),
    templates: readDocs(path.join(exportDir, 'templates')),
  };
}

/** The manifest currently on disk, or null. */
export function readManifest(textDir = DEFAULT_TEXT_DIR) {
  const file = path.join(textDir, 'manifest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const byOrder = (a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || String(a.id).localeCompare(String(b.id));

function settingsOf(raw, where, problems) {
  const s = raw ?? {};
  const out = {};
  for (const key of Object.keys(s)) {
    if (!ORCHESTRATION_KEYS.includes(key) && !OTHER_SETTING_KEYS.includes(key)) problems.push(`${where}: unknown setting "${key}"`);
  }
  if (typeof s.orchestrator === 'string' && s.orchestrator) out.orchestrator = s.orchestrator;
  if (typeof s.model === 'string' && s.model) out.model = s.model;
  if (typeof s.freeAgentMode === 'boolean') out.freeAgentMode = s.freeAgentMode;
  const orchestration = {};
  for (const key of ORCHESTRATION_KEYS) {
    const v = s[key];
    if (v === undefined || v === null) continue;
    const ok = key === 'maxHelpers' ? Number.isInteger(v) && v >= 0 : typeof v === 'boolean';
    if (!ok) problems.push(`${where}: setting "${key}" has a bad value ${JSON.stringify(v)}`);
    else orchestration[key] = v;
  }
  if (Object.keys(orchestration).length > 0) out.orchestration = orchestration;
  return out;
}

const camel = (slug) => slug.replace(/[^a-zA-Z0-9]+(.)/g, (_m, c) => c.toUpperCase()).replace(/^[^a-zA-Z_$]/, '_$&');

/** The generated index.ts for a manifest's block and skill files. */
export function indexSource(manifest) {
  const files = manifest.blocks.map((b) => b.file);
  const names = files.map((f) => `${camel(f.replace(/\.md$/, ''))}Text`);
  const skills = (manifest.skills ?? []).map((sk) => ({ file: sk.file, name: `${camel(sk.id.slice(SKILL_PREFIX.length))}SkillText` }));
  return [
    '// Generated by scripts/sync-builtin-text.mjs. Don\'t edit: sync from the builder export instead.',
    ...files.map((f, i) => `import ${names[i]} from './${f}';`),
    ...skills.map((sk) => `import ${sk.name} from './${sk.file}';`),
    '',
    '/** Every built-in block\'s text, by its file in manifest.json. */',
    'export const BUILTIN_TEXT: Record<string, string> = {',
    ...files.map((f, i) => `  '${f}': ${names[i]},`),
    '};',
    '',
    '/** Every built-in skill\'s SKILL.md, by its file in manifest.json. */',
    'export const BUILTIN_SKILL_TEXT: Record<string, string> = {',
    ...skills.map((sk) => `  '${sk.file}': ${sk.name},`),
    '};',
    '',
  ].join('\n');
}

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A single-line front-matter value: plain, or a YAML double- or single-quoted string. Null for anything else. */
function frontMatterString(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) { try { const parsed = JSON.parse(v); return typeof parsed === 'string' ? parsed : null; } catch { return null; } }
  if (v.startsWith("'")) return v.length > 1 && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : null;
  if (/^[|>]/.test(v)) return null; // block scalars: keep the description on one line
  return v;
}

/** A skill name: 1-64 of a-z, 0-9 and hyphens, no leading, trailing or double hyphen. */
const SKILL_FOLDER_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const MAX_DESCRIPTION = 500;

/**
 * A SKILL.md's front matter: `{ name, description }`, or `{ problem }`. It
 * must have exactly `name` and `description`, each one line. The name is the
 * folder the CLI gets: 1-64 lowercase letters, digits and hyphens, with no
 * leading, trailing or double hyphen, and never `claude` or `anthropic`. The
 * description isn't empty and has at most 500 characters.
 */
export function skillFrontMatter(text) {
  const match = text.match(FRONT_MATTER_RE);
  if (!match) return { problem: 'doesn\'t start with front matter (--- name and description ---)' };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/);
    if (!m) return { problem: `front matter line "${line.trim()}" isn't a one-line key: value` };
    if (m[1] in fields) return { problem: `front matter has ${m[1]} twice` };
    fields[m[1]] = m[2];
  }
  const extra = Object.keys(fields).filter((k) => k !== 'name' && k !== 'description');
  if (extra.length > 0) return { problem: `front matter has ${extra.join(', ')}; only name and description are allowed` };
  if (fields.name === undefined) return { problem: 'front matter has no name' };
  if (fields.description === undefined) return { problem: 'front matter has no description' };
  const name = frontMatterString(fields.name);
  const description = frontMatterString(fields.description);
  if (name === null) return { problem: 'front matter name isn\'t a one-line value' };
  if (description === null) return { problem: 'front matter description isn\'t a one-line value' };
  if (!SKILL_FOLDER_RE.test(name)) return { problem: `front matter name "${name}" must be 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen` };
  if (/claude|anthropic/.test(name)) return { problem: `front matter name "${name}" can't contain "claude" or "anthropic"` };
  if (!description.trim()) return { problem: 'front matter description is empty; the CLI uses it to decide when to load the skill' };
  if (description.trim().length > MAX_DESCRIPTION) return { problem: `front matter description has ${description.trim().length} characters; the most is ${MAX_DESCRIPTION}` };
  return { name, description: description.trim() };
}

/**
 * Build what the files should hold from an export. `current` is the manifest
 * on disk (for ids that must not disappear); `textDir` is where cut blocks'
 * shipped text must already be.
 */
export function plan(exp, { current = null, textDir = DEFAULT_TEXT_DIR } = {}) {
  const problems = [];
  const texts = new Map();
  const blocks = [];
  const known = new Map();

  for (const doc of [...exp.blocks].sort(byOrder)) {
    const where = `block ${doc.id ?? doc.file}`;
    if (!doc.id || !doc.name) { problems.push(`${where}: needs an id and a name`); continue; }
    const id = mapId(doc.id);
    if (!id.startsWith(BLOCK_PREFIX)) { problems.push(`${where}: "${id}" isn't a built-in id (add it to ID_MAP)`); continue; }
    // Its id names its file and its import: an asset id (a-z, 0-9, - and _), never a / or a quote.
    if (catalogChecks && !catalogChecks.isAssetId(id)) { problems.push(`${where}: "${id}" isn't a valid built-in id (lowercase letters, digits, - and _)`); continue; }
    if (!STATUSES.has(doc.status)) problems.push(`${where}: unknown status "${doc.status}"`);
    if (known.has(id)) { problems.push(`${where}: duplicate id ${id}`); continue; }
    const file = `${id.slice(BLOCK_PREFIX.length)}.md`;
    const cut = doc.status === 'cut';
    known.set(id, { cut });
    if (cut) {
      if (doc.origin !== 'builtin' && !current?.blocks?.some((b) => b.id === id)) continue; // never shipped
      if (!existsSync(path.join(textDir, file))) problems.push(`${where}: cut, but its shipped text ${file} is missing`);
    } else {
      const text = typeof doc.text === 'string' ? lf(doc.text).trim() : '';
      if (!text) problems.push(`${where}: has no text`);
      else problems.push(...catalogProblems(where, 'block', id, doc.name, { content: text }));
      texts.set(file, `${text}\n`);
    }
    blocks.push({ id, name: doc.name, description: doc.description ?? '', file, ...(cut && { retired: true }) });
  }

  const skills = [];
  const knownSkills = new Map();
  const skillFiles = new Map();
  for (const doc of [...(exp.skills ?? [])].sort(byOrder)) {
    const where = `skill ${doc.id ?? doc.file}`;
    if (!doc.id || !doc.name) { problems.push(`${where}: needs an id and a name`); continue; }
    if (!doc.id.startsWith(SKILL_PREFIX) || !SKILL_NAME_RE.test(doc.id.slice(SKILL_PREFIX.length))) { problems.push(`${where}: "${doc.id}" isn't a built-in skill id (builtin-skill- and lowercase letters, digits and dashes)`); continue; }
    if (!STATUSES.has(doc.status)) problems.push(`${where}: unknown status "${doc.status}"`);
    if (knownSkills.has(doc.id)) { problems.push(`${where}: duplicate id`); continue; }
    const file = `skills/${doc.id.slice(SKILL_PREFIX.length)}/SKILL.md`;
    const cut = doc.status === 'cut';
    const shipped = current?.skills?.find((sk) => sk.id === doc.id);
    let skillName = '';
    let description = '';
    if (cut) {
      if (doc.origin !== 'builtin' && !shipped) continue; // never shipped
      const have = readOr(path.join(textDir, file));
      if (have === null) problems.push(`${where}: cut, but its shipped ${file} is missing`);
      // It keeps the folder and description it shipped with, like its file.
      const fm = have === null ? {} : skillFrontMatter(have);
      skillName = shipped?.skillName ?? fm.name ?? '';
      description = shipped?.description ?? fm.description ?? '';
    } else {
      // The whole SKILL.md, written exactly as the builder has it.
      const text = typeof doc.text === 'string' ? lf(doc.text) : '';
      if (!text.trim()) problems.push(`${where}: has no text`);
      else {
        const fm = skillFrontMatter(text);
        if (fm.problem) problems.push(`${where}: ${fm.problem}`);
        // The export also gives the folder it parsed: it must agree.
        else if (typeof doc.folder === 'string' && doc.folder !== fm.name) problems.push(`${where}: front matter name "${fm.name}" isn't its folder "${doc.folder}"`);
        else { skillName = fm.name; description = fm.description; }
        // What ensureBuiltins installs: the folder and its SKILL.md, under the library name.
        problems.push(...catalogProblems(where, 'skill', doc.id, doc.name, { skillName: fm.name ?? doc.id.slice(SKILL_PREFIX.length), files: [{ path: 'SKILL.md', content: text }] }));
      }
      // Delivery copies skill files as they are: a wildcard in one would reach the agent unfilled.
      const tokens = [...new Set(text.match(/@@[A-Za-z]+/g) ?? [])];
      if (tokens.length > 0) problems.push(`${where}: uses ${tokens.join(', ')}, which skills don't fill in`);
      skillFiles.set(file, text);
    }
    if (!cut && skills.some((sk) => !sk.retired && sk.name.toLowerCase() === doc.name.toLowerCase())) problems.push(`${where}: another skill is named "${doc.name}"`);
    knownSkills.set(doc.id, { cut, skillName });
    skills.push({ id: doc.id, name: doc.name, skillName, description, file, ...(cut && { retired: true }) });
  }

  // A shipped skill the export no longer has was cut: it stays, retired (D71), with the file it shipped with.
  for (const sk of current?.skills ?? []) {
    if (knownSkills.has(sk.id)) continue;
    if (!existsSync(path.join(textDir, sk.file))) problems.push(`skill ${sk.id}: cut from the export, but its shipped ${sk.file} is missing`);
    knownSkills.set(sk.id, { cut: true, skillName: sk.skillName });
    skills.push({ id: sk.id, name: sk.name, skillName: sk.skillName, description: sk.description, file: sk.file, retired: true });
  }

  const templates = [];
  const seen = new Set();
  for (const doc of [...exp.templates].sort(byOrder)) {
    const where = `template ${doc.id ?? doc.file}`;
    if (!doc.id || !doc.name) { problems.push(`${where}: needs an id and a name`); continue; }
    // Agents and templates point at it, and it lands in source: the same id rules as a part.
    if (catalogChecks && !catalogChecks.isAssetId(doc.id)) { problems.push(`${where}: "${doc.id}" isn't a valid built-in id (lowercase letters, digits, - and _)`); continue; }
    if (catalogChecks && catalogChecks.nameIssues(doc.name).length > 0) problems.push(`${where}: the name isn't a valid name`);
    if (!STATUSES.has(doc.status)) problems.push(`${where}: unknown status "${doc.status}"`);
    if (seen.has(doc.id)) { problems.push(`${where}: duplicate id`); continue; }
    seen.add(doc.id);
    const cut = doc.status === 'cut';
    if (cut && doc.origin !== 'builtin' && !current?.templates?.some((t) => t.id === doc.id)) continue;
    const ids = (Array.isArray(doc.blocks) ? doc.blocks : []).map(mapId);
    if (ids.length === 0) problems.push(`${where}: lists no blocks`);
    for (const id of ids) {
      const block = known.get(id);
      if (!block) problems.push(`${where}: lists unknown block ${id}`);
      else if (block.cut && !cut) problems.push(`${where}: lists cut block ${id}`);
    }
    if (new Set(ids).size !== ids.length) problems.push(`${where}: lists a block twice`);
    // A template with no skills field keeps the skills the manifest gives it.
    const templateSkills = Array.isArray(doc.skills) ? doc.skills : (current?.templates?.find((t) => t.id === doc.id)?.skills ?? []);
    for (const id of templateSkills) {
      const skill = knownSkills.get(id);
      if (!skill) problems.push(`${where}: lists unknown skill ${id}`);
      else if (skill.cut && !cut) problems.push(`${where}: lists cut skill ${id}`);
    }
    if (new Set(templateSkills).size !== templateSkills.length) problems.push(`${where}: lists a skill twice`);
    // One folder holds one skill: an agent gets one variant of each.
    const folders = new Map();
    for (const id of templateSkills) {
      const folder = knownSkills.get(id)?.skillName;
      if (!folder) continue;
      if (folders.has(folder) && folders.get(folder) !== id) problems.push(`${where}: lists ${folders.get(folder)} and ${id}, which both install as ${folder}/`);
      else folders.set(folder, id);
    }
    templates.push({
      id: doc.id, name: doc.name, description: doc.description ?? '', blocks: ids,
      ...(templateSkills.length > 0 && { skills: [...templateSkills] }),
      settings: settingsOf(doc.settings, where, problems), ...(cut && { retired: true }),
    });
  }

  for (const b of current?.blocks ?? []) if (!known.has(b.id)) problems.push(`block ${b.id} is built in but missing from the export; built-in ids never disappear`);
  for (const t of current?.templates ?? []) if (!seen.has(t.id)) problems.push(`template ${t.id} is built in but missing from the export; built-in ids never disappear`);

  const manifest = { $comment: MANIFEST_COMMENT, blocks, skills, templates };
  return { manifest, texts, skillFiles, index: indexSource(manifest), problems };
}

const manifestJson = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function diffList(a, b, label) {
  const out = [];
  const ka = new Map((a ?? []).map((x) => [x.id, x]));
  const kb = new Map((b ?? []).map((x) => [x.id, x]));
  for (const [id, want] of kb) {
    const have = ka.get(id);
    if (!have) { out.push(`${label} ${id}: new`); continue; }
    for (const key of new Set([...Object.keys(have), ...Object.keys(want)])) {
      if (JSON.stringify(have[key]) !== JSON.stringify(want[key])) out.push(`${label} ${id}: ${key} ${JSON.stringify(have[key])} -> ${JSON.stringify(want[key])}`);
    }
  }
  for (const id of ka.keys()) if (!kb.has(id)) out.push(`${label} ${id}: removed`);
  const order = (xs) => (xs ?? []).map((x) => x.id).filter((id) => ka.has(id) && kb.has(id)).join(',');
  if (order(a) !== order(b)) out.push(`${label} order changed`);
  return out;
}

/** What differs between the files in `textDir` and a plan. Empty when in sync. */
export function differences(planned, textDir = DEFAULT_TEXT_DIR) {
  const out = [];
  const current = readManifest(textDir);
  if (!current) out.push('manifest.json: missing');
  else {
    out.push(
      ...diffList(current.blocks, planned.manifest.blocks, 'block'),
      ...diffList(current.skills, planned.manifest.skills, 'skill'),
      ...diffList(current.templates, planned.manifest.templates, 'template'),
    );
    if (out.length === 0 && lf(readOr(path.join(textDir, 'manifest.json')) ?? '') !== manifestJson(planned.manifest)) out.push('manifest.json: formatting');
  }
  for (const [file, text] of planned.texts) {
    const have = readOr(path.join(textDir, file));
    if (have === null) out.push(`${file}: missing`);
    else if (lf(have) !== text) out.push(`${file}: text differs`);
  }
  for (const [file, text] of planned.skillFiles) {
    const have = readOr(path.join(textDir, file));
    if (have === null) out.push(`${file}: missing`);
    else if (lf(have) !== text) out.push(`${file}: text differs`);
  }
  const wanted = new Set(planned.manifest.blocks.map((b) => b.file));
  if (existsSync(textDir)) {
    for (const f of readdirSync(textDir)) if (f.endsWith('.md') && !wanted.has(f)) out.push(`${f}: not a built-in block (would be removed)`);
  }
  for (const folder of strayFolders(planned, textDir)) out.push(`skills/${folder}: not a built-in skill (would be removed)`);
  if (lf(readOr(path.join(textDir, 'index.ts')) ?? '') !== planned.index) out.push('index.ts: out of date');
  return out;
}

/** Folders in `skills/` no skill in the plan uses. */
function strayFolders(planned, textDir) {
  const dir = path.join(textDir, 'skills');
  if (!existsSync(dir)) return [];
  const wanted = new Set(planned.manifest.skills.map((sk) => sk.file.split('/')[1]));
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !wanted.has(e.name)).map((e) => e.name).sort();
}

/** Write a plan into `textDir`, removing .md files no block uses and skill folders no skill uses. */
export function writePlan(planned, textDir = DEFAULT_TEXT_DIR) {
  mkdirSync(textDir, { recursive: true });
  for (const [file, text] of planned.texts) writeFileSync(path.join(textDir, file), text);
  for (const [file, text] of planned.skillFiles) {
    mkdirSync(path.dirname(path.join(textDir, file)), { recursive: true });
    writeFileSync(path.join(textDir, file), text);
  }
  for (const folder of strayFolders(planned, textDir)) rmSync(path.join(textDir, 'skills', folder), { recursive: true, force: true });
  const wanted = new Set(planned.manifest.blocks.map((b) => b.file));
  for (const f of readdirSync(textDir)) if (f.endsWith('.md') && !wanted.has(f)) rmSync(path.join(textDir, f));
  writeFileSync(path.join(textDir, 'manifest.json'), manifestJson(planned.manifest));
  writeFileSync(path.join(textDir, 'index.ts'), planned.index);
}

/** Check (or with `write`, update) `textDir` against an export folder. */
export function syncBuiltinText(exportDir, { write = false, textDir = DEFAULT_TEXT_DIR } = {}) {
  const planned = plan(readExport(exportDir), { current: readManifest(textDir), textDir });
  const diffs = differences(planned, textDir);
  if (write && planned.problems.length === 0 && diffs.length > 0) writePlan(planned, textDir);
  return { problems: planned.problems, differences: diffs, written: write && planned.problems.length === 0 && diffs.length > 0, manifest: planned.manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const exportDir = args.find((a) => !a.startsWith('--'));
  if (!exportDir) {
    console.error('Usage: node scripts/sync-builtin-text.mjs <export folder> [--write]');
    process.exit(2);
  }
  const { problems, differences: diffs, written } = syncBuiltinText(path.resolve(exportDir.replace(/^~(?=\/)/, process.env.HOME ?? '~')), { write });
  for (const p of problems) console.error(`problem: ${p}`);
  for (const d of diffs) console.log(`${written ? 'updated' : 'differs'}: ${d}`);
  if (problems.length > 0) process.exitCode = 1;
  else if (diffs.length === 0) console.log('Built-in text is in sync with the export.');
  else if (!write) { console.error('Out of sync. Run again with --write to update.'); process.exitCode = 1; }
}
