/**
 * Templates a project's repository offers as
 * `.clubhouse/parts/templates/<file>.json` (D255). A file's `id` is its
 * identity, so renaming the file keeps the link to the template made from it.
 *
 * Read like project parts (`project-parts.ts`): bounded, links refused,
 * credentials and duplicate fields refuse the file, nothing runs and nothing
 * is written. A template names parts by repository key (`skill:<folder>`,
 * `block:<name>`, `mcp:<serverKey>`) or by built-in id. Each reference
 * resolves to a project part a person already added, or to a built-in. One
 * that doesn't resolve blocks adding or updating, and nothing is substituted.
 *
 * Settings that raise what agents may do (Clubhouse permissions, access,
 * orchestration and the helper template) are shown apart and are left out
 * unless the person approves them. An update goes through the template push
 * a person makes from Settings: they pick which agents made from it get the
 * changes, which apply at each one's next start. Nothing restarts.
 */
import { redactSecretValues } from '../../telemetry/diag-redaction';
import { canonicalHash } from '../asset-catalog/planner';
import { nameIssues } from '../asset-catalog/validation';
import { appLog } from '../log-service';
import { list as listProjects } from '../project-store';
import {
  PREPARE_HANDOFF_SKILL_ID,
  PROJECT_PARTS_FOLDER,
  type ManagedPartKind,
  type ManagedTemplate,
  type ManagedTemplatePushTarget,
  type ManagedTemplateSettings,
  type ProjectTemplateFile,
  type ProjectTemplateItem,
  type ProjectTemplateRef,
  type ProjectTemplateReview,
  type ProjectTemplatesInventory,
} from '../../../shared/managed-agents-types';
import type { CatalogEntry } from '../../../shared/asset-catalog-types';
import { entries, missing, readFile, refuseDuplicateKeys, safeName, SourceError, sourceProblem } from './discovery';
import { addedParts, projectPartKey, readRepoParts, registeredProject, type PartMeta, type ProjectRef } from './project-parts';
import { builtinPart, checkTemplateSettings, ManagedError, type ManagedAgentsService } from './service';

const TEMPLATES = `${PROJECT_PARTS_FOLDER}/templates`;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_TEMPLATES = 200;
const MAX_REFS = 200;
const ID_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
const FIELDS = new Set(['id', 'name', 'description', 'setup', 'settings']);

export type ProjectTemplatesService = Pick<ManagedAgentsService,
  'liveEntries' | 'projectPartMeta' | 'listTemplates' | 'getTemplate' | 'saveTemplate' | 'previewTemplatePush' | 'pushTemplate' | 'setTemplateProjectHash' | 'diffTemplateSettings'>;

/** Applies a pushed agent's settings, as the person's push from Settings does. */
export type ApplySettings = (projectPath: string, agentId: string, settings: ManagedTemplateSettings) => Promise<void>;

const defaultApplySettings: ApplySettings = async (projectPath, agentId, settings) => {
  // Lazy: agents.ts reaches the spawn path.
  const { applyManagedSettings } = await import('./agents');
  await applyManagedSettings(projectPath, agentId, settings);
};

interface RepoTemplate {
  key: string;
  file?: ProjectTemplateFile;
  hash?: string;
  problem?: string;
}

/** The only settings a template file may hold. Anything else refuses the file. */
const SETTINGS_FIELDS = new Set(['orchestrator', 'model', 'effort', 'access', 'freeAgentMode', 'orchestration', 'idleSleep', 'helperTemplateId', 'grants']);
/** Settings that carry no authority. Every other setting needs the person's tick. */
const PLAIN_SETTINGS = new Set(['orchestrator', 'model', 'effort', 'idleSleep']);
/** Keys that could reach an object's prototype once copied. Refused at any depth. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether a setting (a push-dialog key such as `grants.<…>` or `orchestration.<…>`) can raise what agents may do: anything not on the plain list. */
export function isAuthorityKey(key: string): boolean {
  return !PLAIN_SETTINGS.has(key);
}

function splitSettings(s: ManagedTemplateSettings): { plain: ManagedTemplateSettings; authority: ManagedTemplateSettings } {
  const plain: Record<string, unknown> = {};
  const authority: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    if (value === undefined) continue;
    (PLAIN_SETTINGS.has(key) ? plain : authority)[key] = value;
  }
  return { plain: plain as ManagedTemplateSettings, authority: authority as ManagedTemplateSettings };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS || !value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 160)) {
    throw new SourceError(`The template's ${what} must be a list of part names.`);
  }
  return [...new Set(value as string[])];
}

/** A template file's checked content, or a refusal of the whole file. */
function parseTemplate(text: string): ProjectTemplateFile {
  if (redactSecretValues(text) !== text) throw new SourceError('The template contains credentials; nothing was read.');
  let raw: unknown;
  let prototypeKey = false;
  try {
    raw = JSON.parse(text, (key, value: unknown) => { if (PROTOTYPE_KEYS.has(key)) prototypeKey = true; return value; });
  } catch { throw new SourceError('The template is not valid JSON.'); }
  if (prototypeKey) throw new SourceError('The template uses __proto__, constructor or prototype as a field name; nothing was read.');
  try { refuseDuplicateKeys(text); } catch {
    throw new SourceError('The template has a field twice. Remove the duplicate so it\'s clear which one counts.');
  }
  if (!record(raw)) throw new SourceError('The template must be a JSON object.');
  if (Object.keys(raw).some((k) => !FIELDS.has(k))) throw new SourceError('The template has fields Clubhouse doesn\'t take (only id, name, description, setup and settings).');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || !safeName(raw.id)) throw new SourceError('The template needs an id of letters, digits, dots, dashes or underscores.');
  if (typeof raw.name !== 'string' || !raw.name.trim() || nameIssues(raw.name.trim()).length > 0) throw new SourceError('The template needs a valid name.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 2000)) throw new SourceError('The template\'s description must be text.');
  const setup = raw.setup ?? {};
  if (!record(setup) || Object.keys(setup).some((k) => !['blocks', 'skills', 'mcps'].includes(k))) throw new SourceError('The template\'s setup takes only blocks, skills and mcps.');
  if (raw.settings !== undefined && (!record(raw.settings) || Object.keys(raw.settings).some((k) => !SETTINGS_FIELDS.has(k)))) {
    throw new SourceError(`The template's settings take only ${[...SETTINGS_FIELDS].join(', ')}.`);
  }
  let settings: ManagedTemplateSettings;
  try { settings = checkTemplateSettings(raw.settings); } catch (error) {
    throw new SourceError(error instanceof ManagedError && error.message !== error.code ? error.message : 'The template\'s settings aren\'t valid.');
  }
  return {
    id: raw.id, name: raw.name.trim(), ...(typeof raw.description === 'string' && raw.description.trim() && { description: raw.description.trim() }),
    setup: { blocks: refList(setup.blocks, 'blocks'), skills: refList(setup.skills, 'skills'), mcps: refList(setup.mcps, 'mcps') },
    ...(Object.keys(settings).length > 0 && { settings }),
  };
}

/** A refused file's own id, when it has a valid one, so its row stays under that id. Read only as a string; nothing else is used. */
function refusedKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    const id = record(raw) ? raw.id : undefined;
    return typeof id === 'string' && ID_RE.test(id) && safeName(id) && redactSecretValues(id) === id ? id : undefined;
  } catch {
    // telemetry-exempt: not JSON, so it's listed by file name
    return undefined;
  }
}

/** Every template file in the repository, read within limits. Two files with one id refuse both. */
export async function readRepoTemplates(root: string): Promise<{ templates: RepoTemplate[]; notes: string[] }> {
  const notes: string[] = [];
  let names: string[] = [];
  try {
    const found = await entries(root, TEMPLATES, MAX_TEMPLATES);
    if (found.truncated) notes.push(`Only the first ${MAX_TEMPLATES} template files were read.`);
    names = found.names.filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith('.json'));
  } catch (error) {
    // telemetry-exempt: a missing folder is ordinary; anything else is a content-free note.
    if (!missing(error)) notes.push(`Templates weren't read: ${sourceProblem(error)}`);
    return { templates: [], notes };
  }
  const read: Array<RepoTemplate & { fileName: string }> = [];
  for (const fileName of names) {
    if (!safeName(fileName)) { notes.push('A template file with an unsafe name was skipped.'); continue; }
    let text: string | undefined;
    try {
      text = (await readFile(root, `${TEMPLATES}/${fileName}`, MAX_TEMPLATE_BYTES)).bytes.toString('utf8');
      const file = parseTemplate(text);
      read.push({ fileName, key: file.id, file, hash: canonicalHash(file) });
    } catch (error) {
      // telemetry-exempt: listed with a content-free reason, under its id when one can be told, so a template added from it isn't shown as gone.
      read.push({ fileName, key: refusedKey(text) ?? `file:${fileName}`, problem: sourceProblem(error) });
    }
  }
  const counts = new Map<string, number>();
  for (const t of read) if (!t.key.startsWith('file:')) counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
  const templates = read.map(({ fileName: _f, ...t }): RepoTemplate => (!t.key.startsWith('file:') && (counts.get(t.key) ?? 0) > 1
    ? { key: t.key, problem: 'Another template file uses the same id. Give each one its own id.' }
    : t));
  // One entry per duplicated id.
  const seen = new Set<string>();
  return { templates: templates.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true))), notes };
}

function kindOf(list: 'blocks' | 'skills' | 'mcps'): ManagedPartKind {
  return list === 'blocks' ? 'block' : list === 'skills' ? 'skill' : 'mcp';
}

/**
 * Each part reference, as it resolves now against the library and the
 * repository. `<kind>:<name>` names a repository part by its folder, file
 * name (without `.md`) or server key as written; it resolves to the part added
 * from it, or the library part chosen for it.
 */
function resolveRefs(file: ProjectTemplateFile, live: Record<string, CatalogEntry>, meta: PartMeta, projectId: string, repoKeys: Set<string>): ProjectTemplateRef[] {
  const added = addedParts(live, meta, projectId);
  const out: ProjectTemplateRef[] = [];
  for (const list of ['blocks', 'skills', 'mcps'] as const) {
    const kind = kindOf(list);
    for (const ref of file.setup[list]) {
      const colon = ref.indexOf(':');
      if (colon > 0) {
        const key = ref.slice(0, colon) === kind ? projectPartKey(kind, ref.slice(colon + 1)) : undefined;
        const entry = key ? added.get(key) : undefined;
        if (entry && entry.kind === kind) out.push({ ref, kind, partId: entry.id, partName: entry.name });
        else out.push({ ref, kind, unresolved: key && repoKeys.has(key) ? 'not_added' : 'missing' });
        continue;
      }
      const entry = live[ref];
      // prepare-handoff follows the agent's grants (D253), so no template can choose it.
      if (entry && entry.source.kind === 'builtin' && entry.kind === kind && !builtinPart(ref)?.retired && ref !== PREPARE_HANDOFF_SKILL_ID) out.push({ ref, kind, partId: entry.id, partName: entry.name });
      else out.push({ ref, kind, unresolved: 'missing' });
    }
  }
  return out;
}

/**
 * The template a repository file makes here: parts as library ids, settings
 * that carry authority from the file only when approved and otherwise from
 * `base` (unset for a new template, the current one's for an update). A helper
 * template is kept when it's a built-in, or `template:<id>` naming a template
 * already added from this project.
 */
function resolvedTemplate(
  file: ProjectTemplateFile, refs: ProjectTemplateRef[], approve: boolean, base: ManagedTemplateSettings,
  templates: ManagedTemplate[], projectId: string, notes: string[],
): Pick<ManagedTemplate, 'setup' | 'settings'> {
  const ids = (kind: ManagedPartKind) => refs.filter((r) => r.kind === kind && r.partId).map((r) => r.partId!);
  const fromFile = splitSettings(file.settings ?? {});
  const authority = { ...(approve ? fromFile.authority : splitSettings(base).authority) };
  if (approve && typeof authority.helperTemplateId === 'string') {
    const wanted = authority.helperTemplateId;
    const resolved = wanted.startsWith('template:')
      ? templates.find((t) => t.source?.projectId === projectId && t.source.key === wanted.slice('template:'.length))?.id
      : templates.find((t) => t.builtin && t.id === wanted)?.id;
    if (resolved) authority.helperTemplateId = resolved;
    else { delete authority.helperTemplateId; notes.push(`The helper template ${wanted} isn't a built-in or a template added from this project, so it's left out.`); }
  }
  return { setup: { blocks: ids('block'), skills: ids('skill'), mcps: ids('mcp') }, settings: { ...fromFile.plain, ...authority } };
}

async function inventoryOf(service: ProjectTemplatesService, project: ProjectRef): Promise<{ inventory: ProjectTemplatesInventory; repo: Map<string, RepoTemplate> }> {
  const { templates, notes } = await readRepoTemplates(project.path);
  const mine = (await service.listTemplates()).filter((t) => t.source?.kind === 'project' && t.source.projectId === project.id);
  const byKey = new Map(mine.map((t) => [t.source!.key, t]));
  const items: ProjectTemplateItem[] = templates.map((r) => {
    const t = byKey.get(r.key);
    const base = { key: r.key, name: r.file?.name ?? r.key.replace(/^file:/, ''), ...(r.hash && { hash: r.hash }), ...(t && { templateId: t.id, templateName: t.name }) };
    if (r.problem) return { ...base, state: 'refused', problem: r.problem };
    if (!t) return { ...base, state: 'available' };
    if (!t.projectHash || t.projectHash === r.hash) return { ...base, state: 'added' };
    return { ...base, state: t.projectKeptHash === r.hash ? 'kept' : 'changed' };
  });
  const offered = new Set(templates.map((r) => r.key));
  // A file whose id can't be read might hold any of them, so none is said to be gone for sure.
  const unsure = templates.some((r) => r.key.startsWith('file:'));
  const gone = mine.filter((t) => !offered.has(t.source!.key))
    .map((t) => ({ key: t.source!.key, templateId: t.id, templateName: t.name, ...(unsure && { unsure: true as const }) }));
  return {
    inventory: { projectPath: project.path, projectId: project.id, projectName: project.name, items, gone, notes },
    repo: new Map(templates.map((r) => [r.key, r])),
  };
}

/** What a project's repository offers as templates now. Reads only. */
export async function projectTemplatesInventory(service: ProjectTemplatesService, projectPath: string): Promise<ProjectTemplatesInventory> {
  return (await inventoryOf(service, await registeredProject(projectPath))).inventory;
}

/** Every registered project that offers templates, or has templates added from it. Reads only. */
export async function allProjectTemplates(service: ProjectTemplatesService): Promise<ProjectTemplatesInventory[]> {
  const out: ProjectTemplatesInventory[] = [];
  for (const p of await listProjects()) {
    try {
      const { inventory } = await inventoryOf(service, { id: p.id, name: p.displayName || p.name, path: p.path });
      if (inventory.items.length > 0 || inventory.gone.length > 0) out.push(inventory);
    } catch (error) {
      // telemetry-exempt: one unreadable project doesn't hide the others; logged without paths.
      appLog('core:managed', 'warn', 'A project\'s templates could not be read', { meta: { projectId: p.id, error: error instanceof ManagedError ? error.code : 'unknown' } });
    }
  }
  return out;
}

interface Resolved {
  project: ProjectRef;
  item: ProjectTemplateItem;
  file: ProjectTemplateFile;
  hash: string;
  refs: ProjectTemplateRef[];
  current?: ManagedTemplate & { usedBy: number };
  next: Pick<ManagedTemplate, 'setup' | 'settings'>;
  notes: string[];
}

async function resolve(service: ProjectTemplatesService, projectPath: string, key: string, approve: boolean): Promise<Resolved> {
  const project = await registeredProject(projectPath);
  const { inventory, repo } = await inventoryOf(service, project);
  const item = inventory.items.find((i) => i.key === key);
  const read = repo.get(key);
  if (!item || !read) throw new ManagedError('not_found', 'The repository no longer has it. Check again.');
  if (!read.file || !read.hash) throw new ManagedError('invalid', item.problem ?? 'It can\'t be read safely.');
  const live = await service.liveEntries();
  const { parts } = await readRepoParts(project.path);
  const refs = resolveRefs(read.file, live, await service.projectPartMeta(), project.id, new Set(parts.filter((p) => !p.problem).map((p) => p.key)));
  const templates = await service.listTemplates();
  const current = item.templateId ? templates.find((t) => t.id === item.templateId) : undefined;
  const notes: string[] = [];
  const next = resolvedTemplate(read.file, refs, approve, current?.settings ?? {}, templates, project.id, notes);
  return { project, item, file: read.file, hash: read.hash, refs, ...(current && { current }), next, notes };
}

function refuseUnresolved(refs: ProjectTemplateRef[]): void {
  const open = refs.filter((r) => r.unresolved);
  if (open.length === 0) return;
  const notAdded = open.filter((r) => r.unresolved === 'not_added').map((r) => r.ref);
  const gone = open.filter((r) => r.unresolved === 'missing').map((r) => r.ref);
  throw new ManagedError('invalid', [
    notAdded.length > 0 ? `Add ${notAdded.join(', ')} from the repository first.` : '',
    gone.length > 0 ? `${gone.join(', ')} isn't a repository part or a built-in.` : '',
  ].filter(Boolean).join(' '));
}

/**
 * Everything a person needs to decide on one repository template: its parts as
 * they resolve, plain settings and permissions shown apart, and for a change
 * the push it would make with `approvePermissions` as given.
 */
export async function reviewProjectTemplate(service: ProjectTemplatesService, projectPath: string, key: string, approvePermissions = false): Promise<ProjectTemplateReview> {
  const r = await resolve(service, projectPath, key, approvePermissions);
  const base = r.current?.settings ?? {};
  const all = await service.diffTemplateSettings(base, r.file.settings ?? {});
  const settings = all.filter((c) => c.kind === 'setting' && !isAuthorityKey(c.key));
  const permissions = all.filter((c) => c.kind === 'setting' && isAuthorityKey(c.key));
  const taken = new Set((await service.listTemplates()).map((t) => t.name.toLowerCase()));
  let suggestedName = r.file.name;
  for (let n = 2; taken.has(suggestedName.toLowerCase()) && n < 1000; n++) suggestedName = `${r.file.name} ${n}`;
  let push: ProjectTemplateReview['push'];
  if (r.current && !r.refs.some((x) => x.unresolved)) push = await service.previewTemplatePush(r.current.id, r.next);
  return {
    item: r.item, projectName: r.project.name, description: r.file.description ?? '', refs: r.refs, settings, permissions, notes: r.notes, suggestedName,
    ...(r.current && { current: { id: r.current.id, name: r.current.name, consumers: r.current.usedBy } }),
    ...(push && { push }),
  };
}

/**
 * Add a reviewed repository template. Its permissions come along only with
 * `approvePermissions`. `hash` pins the copy reviewed. Agents start from it
 * through New agent like from any template.
 */
export async function addProjectTemplate(
  service: ProjectTemplatesService, projectPath: string, key: string, hash: string,
  choice: { name: string; approvePermissions: boolean },
): Promise<ManagedTemplate> {
  const r = await resolve(service, projectPath, key, choice.approvePermissions);
  if (r.hash !== hash) throw new ManagedError('stale', 'It changed in the repository since you reviewed it. Review it again.');
  if (r.current) throw new ManagedError('invalid', `It's already a template: ${r.current.name}.`);
  refuseUnresolved(r.refs);
  const name = choice.name.trim();
  if (!name || nameIssues(name).length > 0 || redactSecretValues(name) !== name) throw new ManagedError('invalid', 'Check the name.');
  const made = await service.saveTemplate(
    { name, description: r.file.description ?? '', setup: r.next.setup, settings: r.next.settings },
    { source: { kind: 'project', projectId: r.project.id, key }, projectHash: r.hash },
  );
  appLog('core:managed', 'info', 'Project template added', { meta: { templateId: made.id, permissions: choice.approvePermissions } });
  return made;
}

/**
 * Update a template from its repository's changed copy through the person's
 * template push: the agents in `targets` get the changes that still apply to
 * them, at their next start, and the rest keep what they have. Nothing restarts.
 * The template's name and description stay as they are here.
 */
export async function updateProjectTemplate(
  service: ProjectTemplatesService, projectPath: string, templateId: string, hash: string,
  choice: { approvePermissions: boolean; targets: Array<Pick<ManagedTemplatePushTarget, 'projectPath' | 'agentId'>> },
  applySettings: ApplySettings = defaultApplySettings,
): Promise<{ failed: Array<{ agentId: string; message: string }> }> {
  const template = (await service.listTemplates()).find((t) => t.id === templateId);
  if (!template?.source) throw new ManagedError('not_found', 'It isn\'t a template from a project.');
  const r = await resolve(service, projectPath, template.source.key, choice.approvePermissions);
  if (r.current?.id !== templateId) throw new ManagedError('not_found', 'It isn\'t a template from this project.');
  if (r.hash !== hash) throw new ManagedError('stale', 'It changed in the repository since you reviewed it. Review it again.');
  refuseUnresolved(r.refs);
  const results = await service.pushTemplate(templateId, r.next, choice.targets);
  const failed: Array<{ agentId: string; message: string }> = [];
  for (const t of results) {
    if (t.failed) { failed.push({ agentId: t.agentId, message: t.failed }); continue; }
    try { await applySettings(t.projectPath, t.agentId, t.settings); }
    catch (err) { /* telemetry-exempt: reported per agent to the person */ failed.push({ agentId: t.agentId, message: err instanceof Error ? err.message : String(err) }); }
  }
  await service.setTemplateProjectHash(templateId, { projectHash: r.hash });
  return { failed };
}

/** Keep mine: the template stays as it is, and this repository copy doesn't ask again. */
export async function keepProjectTemplate(service: ProjectTemplatesService, projectPath: string, templateId: string, hash: string): Promise<void> {
  const project = await registeredProject(projectPath);
  const template = (await service.listTemplates()).find((t) => t.id === templateId);
  if (!template?.source || template.source.projectId !== project.id) throw new ManagedError('not_found', 'It isn\'t a template from this project.');
  await service.setTemplateProjectHash(templateId, { keptHash: hash });
}

