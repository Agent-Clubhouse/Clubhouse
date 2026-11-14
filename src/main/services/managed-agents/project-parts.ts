/**
 * Parts a project's repository offers under `.clubhouse/parts/`: skill
 * folders in `skills/`, instruction blocks as `instructions/<name>.md`, and
 * MCP servers in `mcp.json` (`{ "mcpServers": { ... } }`).
 *
 * Checked-in files are untrusted. Reading them runs nothing: no hook, script
 * or MCP server, and it writes nothing, to the library or anywhere else. The
 * reads are the bounded, link-refusing ones #2855's import uses, and a skill
 * with credentials or a server with unsupported fields is refused whole.
 * Literal env values become names. A part reaches the library only when a
 * person adds it, and an agent only when a person selects it and saves the
 * setup the usual way. Nothing here touches grants, approvals or agents.
 *
 * Added parts are library parts with a `project` source (ids only, never a
 * path). The repository's copy never updates one by itself: a change shows as
 * `changed`, with Update and Keep mine, as a shared part's edit would. A part
 * the repository drops, or a project that's removed, leaves the part and the
 * agents that use it as they are.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import { redactSecretValues } from '../../telemetry/diag-redaction';
import { canonicalHash } from '../asset-catalog/planner';
import { isCatalogId, MAX_BLOCK_BYTES, nameIssues, validatePayload } from '../asset-catalog/validation';
import { isSameProject } from '../agent-config';
import { appLog } from '../log-service';
import { list as listProjects } from '../project-store';
import {
  PROJECT_PARTS_FOLDER,
  type ManagedPartContent,
  type ManagedPartKind,
  type ManagedPartSummary,
  type ProjectPartChoice,
  type ProjectPartItem,
  type ProjectPartReview,
  type ProjectPartsInventory,
} from '../../../shared/managed-agents-types';
import { MAX_LISTED_SKILLS } from '../../../shared/skills-folder';
import type { CatalogEntry } from '../../../shared/asset-catalog-types';
import { declaredDependencies } from './dependencies';
import { entries, mcpServerContent, missing, readFile, readMcpServers, readSkillBundle, safeName, SourceError, sourceProblem } from './discovery';
import { builtinPart, ManagedError, type ManagedAgentsService } from './service';

const SKILLS = `${PROJECT_PARTS_FOLDER}/skills`;
const INSTRUCTIONS = `${PROJECT_PARTS_FOLDER}/instructions`;
const MCP_FILE = `${PROJECT_PARTS_FOLDER}/mcp.json`;

/** What the person's project-part calls need from the managed service. */
export type ProjectPartsService = Pick<ManagedAgentsService,
  'liveEntries' | 'getPart' | 'headContent' | 'createPart' | 'updatePart' | 'projectPartMeta' | 'linkProjectPart' | 'keepProjectVersion'>;

export interface ProjectRef { id: string; name: string; path: string }

/** One repository part as read: its content, or why it couldn't be read. */
interface RepoPart {
  key: string;
  kind: ManagedPartKind;
  name: string;
  content?: ManagedPartContent;
  droppedEnvValues: string[];
  hash?: string;
  problem?: string;
}

/** The same hash for the same content, whatever order a skill's files were read in. */
export function projectContentHash(content: ManagedPartContent): string {
  return canonicalHash(content.kind === 'skill' ? { ...content, files: [...content.files].sort((a, b) => a.path.localeCompare(b.path)) } : content);
}

async function registeredProject(projectPath: string): Promise<ProjectRef> {
  for (const p of await listProjects()) {
    if (await isSameProject(p.path, projectPath)) return { id: p.id, name: p.displayName || p.name, path: p.path };
  }
  throw new ManagedError('not_found', `${path.basename(projectPath)} isn't a registered project.`);
}

/**
 * A repository part's key: `<kind>:<name>` when that's a catalog id, and
 * otherwise (spaces, other scripts) a slug of the name and a short hash of
 * it, the same every time for the same name. The name is shown as it is.
 */
export function projectPartKey(kind: ManagedPartKind, name: string): string {
  const plain = `${kind}:${name}`;
  if (isCatalogId(plain)) return plain;
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 80);
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 10);
  return `${kind}:${slug ? `${slug}-` : ''}${hash}`;
}

function part(kind: ManagedPartKind, name: string, read: () => Promise<{ content: ManagedPartContent; droppedEnvValues?: string[] }>): Promise<RepoPart> {
  const key = projectPartKey(kind, name);
  return read().then(
    ({ content, droppedEnvValues = [] }) => ({ key, kind, name, content, droppedEnvValues, hash: projectContentHash(content) }),
    // telemetry-exempt: a refused part is listed with a content-free reason.
    (error: unknown): RepoPart => ({ key, kind, name, droppedEnvValues: [], problem: sourceProblem(error) }),
  );
}

async function readBlock(root: string, file: string): Promise<{ content: ManagedPartContent }> {
  const { bytes } = await readFile(root, `${INSTRUCTIONS}/${file}`, MAX_BLOCK_BYTES);
  const text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new SourceError('The instruction file isn\'t plain text.');
  if (redactSecretValues(text) !== text) throw new SourceError('The instruction file contains credentials; nothing was read.');
  if (!text.trim()) throw new SourceError('The instruction file is empty.');
  if (!validatePayload('block', { content: text }).ok) throw new SourceError('The instruction file can\'t be a block.');
  return { content: { kind: 'block', content: text } };
}

/**
 * Every part the project's repository offers, read once, within limits. A
 * missing folder or file is no parts; anything else unreadable is a note or
 * a refused part, never a partial one.
 */
export async function readRepoParts(root: string): Promise<{ parts: RepoPart[]; notes: string[] }> {
  const parts: RepoPart[] = [];
  const notes: string[] = [];
  const list = async (folder: string, what: string): Promise<string[]> => {
    try {
      const found = await entries(root, folder, MAX_LISTED_SKILLS);
      if (found.truncated) notes.push(`Only the first ${MAX_LISTED_SKILLS} ${what} were read.`);
      return found.names.filter((n) => !n.startsWith('.'));
    } catch (error) {
      // telemetry-exempt: a missing folder is ordinary; anything else is a content-free note.
      if (!missing(error)) notes.push(`${what[0].toUpperCase()}${what.slice(1)} weren't read: ${sourceProblem(error)}`);
      return [];
    }
  };
  for (const name of await list(SKILLS, 'skill folders')) {
    if (!safeName(name)) { notes.push('A skill folder with an unsafe name was skipped.'); continue; }
    parts.push(await part('skill', name, async () => ({ content: await readSkillBundle(root, `${SKILLS}/${name}`, name) })));
  }
  for (const file of await list(INSTRUCTIONS, 'instruction files')) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!name || !safeName(file)) { notes.push('An instruction file with an unsafe name was skipped.'); continue; }
    parts.push(await part('block', name, () => readBlock(root, file)));
  }
  try {
    const { servers } = await readMcpServers(root, MCP_FILE);
    for (const name of Object.keys(servers).sort()) {
      // Clubhouse's own server is in every setup already.
      if (/^clubhouse(?:[-_.].*)?$/i.test(name)) { notes.push('The clubhouse server is Clubhouse\'s own, so it isn\'t offered.'); continue; }
      if (!safeName(name)) { notes.push('An MCP server with an unsafe name was skipped.'); continue; }
      parts.push(await part('mcp', name, async () => mcpServerContent(name, servers[name])));
    }
  } catch (error) {
    // telemetry-exempt: a missing file is ordinary; anything else is a content-free note.
    if (!missing(error)) notes.push(`${MCP_FILE} wasn't read: ${sourceProblem(error)}`);
  }
  return { parts, notes };
}

type PartMeta = Awaited<ReturnType<ProjectPartsService['projectPartMeta']>>;

/** This project's parts in the library, by key: parts added from it, and library parts a person chose for one of its parts. */
function addedParts(live: Record<string, CatalogEntry>, meta: PartMeta, projectId: string): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const entry of Object.values(live)) {
    const link = meta[entry.id]?.projectLink;
    if (link?.projectId === projectId && !out.has(link.key)) out.set(link.key, entry);
  }
  // A part made from the repository wins over a chosen one for the same key.
  for (const entry of Object.values(live)) {
    if (entry.source.kind === 'project' && entry.source.projectId === projectId) out.set(entry.source.key, entry);
  }
  return out;
}

/** The repository key a library part follows in this project, if it does. */
function keyOf(entry: CatalogEntry | undefined, meta: PartMeta, projectId: string): string | undefined {
  if (!entry) return undefined;
  if (entry.source.kind === 'project') return entry.source.projectId === projectId ? entry.source.key : undefined;
  const link = meta[entry.id]?.projectLink;
  return link?.projectId === projectId ? link.key : undefined;
}

async function inventoryOf(service: ProjectPartsService, project: ProjectRef): Promise<{ inventory: ProjectPartsInventory; repo: Map<string, RepoPart> }> {
  const { parts, notes } = await readRepoParts(project.path);
  const live = await service.liveEntries();
  const hashes = await service.projectPartMeta();
  const added = addedParts(live, hashes, project.id);
  const items: ProjectPartItem[] = parts.map((p) => {
    const entry = added.get(p.key);
    const base = { key: p.key, kind: p.kind, name: p.name, ...(p.hash && { hash: p.hash }), ...(entry && { partId: entry.id, partName: entry.name }) };
    if (p.problem) return { ...base, state: 'refused', problem: p.problem };
    if (!entry) return { ...base, state: 'available' };
    const h = hashes[entry.id] ?? {};
    if (!h.projectHash || h.projectHash === p.hash) return { ...base, state: 'added' };
    return { ...base, state: h.projectKeptHash === p.hash ? 'kept' : 'changed' };
  });
  const offered = new Set(parts.map((p) => p.key));
  const gone = [...added].filter(([key]) => !offered.has(key)).map(([key, entry]) => ({ key, partId: entry.id, partName: entry.name }));
  return {
    inventory: { projectId: project.id, projectName: project.name, items, gone, notes },
    repo: new Map(parts.map((p) => [p.key, p])),
  };
}

/** What the project's repository offers now, and how each part stands against the library. Reads only. */
export async function projectPartsInventory(service: ProjectPartsService, projectPath: string): Promise<ProjectPartsInventory> {
  return (await inventoryOf(service, await registeredProject(projectPath))).inventory;
}

/** One readable repository part and its state, read again now. */
async function current(service: ProjectPartsService, project: ProjectRef, key: string): Promise<{ item: ProjectPartItem; repo: RepoPart & { content: ManagedPartContent; hash: string } }> {
  const { inventory, repo } = await inventoryOf(service, project);
  const item = inventory.items.find((i) => i.key === key);
  const read = repo.get(key);
  if (!item || !read) throw new ManagedError('not_found', 'The repository no longer has it. Check again.');
  if (!read.content || !read.hash) throw new ManagedError('invalid', item.problem ?? 'It can\'t be read safely.');
  return { item, repo: read as RepoPart & { content: ManagedPartContent; hash: string } };
}

function freeName(live: Record<string, CatalogEntry>, kind: ManagedPartKind, wanted: string): string {
  const taken = new Set(Object.values(live).filter((e) => e.kind === kind).map((e) => e.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${wanted} ${n}`.toLowerCase())) return `${wanted} ${n}`;
  return `${wanted} ${Date.now()}`;
}

/** Everything a person needs to decide on one repository part: its content, what matches it in the library, and for a change, the library's version. */
export async function reviewProjectPart(service: ProjectPartsService, projectPath: string, key: string): Promise<ProjectPartReview> {
  const project = await registeredProject(projectPath);
  const { item, repo } = await current(service, project, key);
  const live = await service.liveEntries();
  const matches: ProjectPartReview['matches'] = [];
  for (const entry of Object.values(live)) {
    if (entry.kind !== repo.kind || entry.id === item.partId) continue;
    const sameName = entry.name.toLowerCase() === repo.name.toLowerCase() || entry.name.toLowerCase() === `${project.name}: ${repo.name}`.toLowerCase();
    // Content only: a full summary would read every project's agents once per part.
    if (entry.source.kind === 'builtin' && builtinPart(entry.id)?.retired) continue;
    const head = await service.headContent(entry.id);
    if (!head) continue;
    const sameContent = projectContentHash(head.content) === repo.hash;
    if (sameName || sameContent) matches.push({ id: entry.id, name: entry.name, sameContent, builtin: entry.source.kind === 'builtin' });
  }
  let currentPart: ProjectPartReview['current'];
  if (item.partId) {
    const p = await service.getPart(item.partId);
    currentPart = { id: p.id, name: p.name, revision: p.revision, content: p.content, usedBy: p.usedBy.length };
  }
  const deps = declaredDependencies(repo.content);
  return {
    item,
    projectName: project.name,
    content: repo.content,
    droppedEnvValues: repo.droppedEnvValues,
    dependencies: deps.declared.map((d) => `${d.name} (${d.kind})`),
    matches: matches.sort((a, b) => Number(b.sameContent) - Number(a.sameContent) || a.name.localeCompare(b.name)),
    suggestedName: freeName(live, repo.kind, repo.name),
    ...(currentPart && { current: currentPart }),
  };
}

/**
 * Add a repository part to the library, as the person chose: a new part with
 * the project as its source, or a library part with exactly the same content.
 * `hash` is the copy they reviewed; a different one now is refused as stale.
 * Assigning it to an agent is still the builder's save.
 */
export async function addProjectPart(service: ProjectPartsService, projectPath: string, key: string, hash: string, choice: ProjectPartChoice): Promise<ManagedPartSummary> {
  const project = await registeredProject(projectPath);
  const { item, repo } = await current(service, project, key);
  if (repo.hash !== hash) throw new ManagedError('stale', 'It changed in the repository since you reviewed it. Review it again.');
  if (item.partId) throw new ManagedError('invalid', `It's already in the library as ${item.partName}.`);
  if (choice.mode === 'reuse') {
    const p = await service.getPart(choice.partId);
    if (p.retired || projectContentHash(p.content) !== repo.hash) throw new ManagedError('stale', 'That library part isn\'t the same as the repository\'s copy. Review it again.');
    if (p.builtin) throw new ManagedError('invalid', `${p.name} is built-in, so it can't follow the repository's copy. Add the copy as its own part.`);
    // From now on a change to the repository's copy shows on that part, as for one made from it.
    await service.linkProjectPart(p.id, { projectId: project.id, key }, repo.hash);
    const { content: _content, ...summary } = await service.getPart(p.id);
    return summary;
  }
  const name = choice.name.trim();
  if (!name || nameIssues(name).length > 0 || redactSecretValues(name) !== name) throw new ManagedError('invalid', 'Check the name.');
  const created = await service.createPart({
    name,
    description: `From ${project.name}'s repository (${PROJECT_PARTS_FOLDER}). A change there asks before it updates this part.`,
    content: repo.content,
    source: { kind: 'project', projectId: project.id, key },
    projectHash: repo.hash,
  });
  appLog('core:managed', 'info', 'Project part added to the library', { meta: { partId: created.id, kind: repo.kind } });
  return created;
}

/**
 * Update the library part from the repository's changed copy, after the person
 * saw the difference. Agents that use it get it at their next start, like any
 * shared edit. `expectedRevision` and `hash` pin what they reviewed.
 */
export async function updateProjectPart(service: ProjectPartsService, projectPath: string, partId: string, expectedRevision: number, hash: string): Promise<ManagedPartSummary> {
  const { repo } = await followed(service, projectPath, partId, hash);
  return service.updatePart({ id: partId, expectedRevision, content: repo.content, projectHash: repo.hash });
}

/** Keep mine: the library part stays as it is, and this repository copy doesn't ask again. */
export async function keepProjectPart(service: ProjectPartsService, projectPath: string, partId: string, hash: string): Promise<void> {
  await followed(service, projectPath, partId, hash);
  await service.keepProjectVersion(partId, hash);
}

/** A library part that follows one of this project's repository parts, and that part read now, pinned to the copy the person reviewed. */
async function followed(service: ProjectPartsService, projectPath: string, partId: string, hash: string) {
  const project = await registeredProject(projectPath);
  const key = keyOf((await service.liveEntries())[partId], await service.projectPartMeta(), project.id);
  if (!key) throw new ManagedError('not_found', 'It isn\'t a part from this project.');
  const read = await current(service, project, key);
  if (read.repo.hash !== hash) throw new ManagedError('stale', 'It changed in the repository since you reviewed it. Review it again.');
  return read;
}
