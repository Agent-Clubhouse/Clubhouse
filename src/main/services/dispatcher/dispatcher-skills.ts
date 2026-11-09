/**
 * The Dispatcher's built-in skills (#3051): step-by-step guides for the
 * procedures it repeats, split out of its instructions. Clubhouse owns them
 * like the instructions: they ship with the app, there is no user copy and no
 * view of them in v1, and a new app version's text reaches an existing
 * Dispatcher at the next instructions write (app start, a CLI change, and
 * before each session starts).
 *
 * Each is `skills/<role>/<name>/SKILL.md`, with `name` and `description`
 * front matter, the format every supported CLI reads. `chat` skills go to the
 * folder of the agent the user talks to, `work` skills to the folder of the
 * one that does the work.
 *
 * Provider-neutral: each is written into the CLI's own skills folder
 * (skillsFolderOf) beside a managed-skills manifest naming what Clubhouse
 * wrote, and the instructions list every skill with its file, so a CLI that
 * doesn't load skills from that folder still reads it when it applies.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { MANAGED_SKILLS_MANIFEST, skillsFolderOf } from '../../../shared/skills-folder';
import type { DispatcherRole } from '../../../shared/dispatcher-behavior';
import catchingUp from './skills/chat/catching-up/SKILL.md';
import whatElseCanYouDo from './skills/chat/what-else-can-you-do/SKILL.md';
import agentCards from './skills/work/agent-cards/SKILL.md';
import checkIns from './skills/work/check-ins/SKILL.md';
import delegatingWork from './skills/work/delegating-work/SKILL.md';
import memoryUpkeep from './skills/work/memory-upkeep/SKILL.md';
import passingOnNews from './skills/work/passing-on-news/SKILL.md';

export interface DispatcherSkill {
  /** The folder the CLI gets, and the front matter's `name`. */
  name: string;
  /** When to use it: the front matter's `description`. */
  description: string;
  role: DispatcherRole;
  /** The whole SKILL.md, front matter included. */
  text: string;
}

/** The skills folder conventions of a provider, as the orchestrators declare them. */
export interface SkillsConventions {
  configDir: string;
  skillsDir: string;
  skillsRoot?: string;
  previousSkillsRoots?: string[];
}

/** `name` and `description` from a SKILL.md's front matter. Throws on a file without them: a build-time mistake. */
export function parseSkill(text: string, role: DispatcherRole): DispatcherSkill {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const field = (key: string) => front?.[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  const name = field('name');
  const description = field('description');
  if (!name || !description) throw new Error('A Dispatcher skill needs name and description front matter');
  return { name, description, role, text };
}

export const DISPATCHER_SKILLS: readonly DispatcherSkill[] = [
  parseSkill(whatElseCanYouDo, 'chat'),
  parseSkill(catchingUp, 'chat'),
  parseSkill(delegatingWork, 'work'),
  parseSkill(passingOnNews, 'work'),
  parseSkill(checkIns, 'work'),
  parseSkill(agentCards, 'work'),
  parseSkill(memoryUpkeep, 'work'),
];

export function dispatcherSkills(role: DispatcherRole): DispatcherSkill[] {
  return DISPATCHER_SKILLS.filter((s) => s.role === role);
}

/** Where one skill's file is, relative to the agent's folder, with forward slashes. */
export function skillFile(conventions: SkillsConventions, name: string): string {
  return `${skillsFolderOf(conventions)}/${name}/SKILL.md`;
}

/**
 * The instructions section that lists the role's skills, each with its file.
 * Some CLIs offer skills by name and some don't, so it says to read the file.
 */
export function skillsSection(role: DispatcherRole, conventions: SkillsConventions): string {
  const lines = dispatcherSkills(role).map((s) => `- \`${s.name}\` (\`${skillFile(conventions, s.name)}\`): ${s.description}`);
  return [
    '## Skills',
    '',
    'Step-by-step guides for things you do often. When one applies, follow it. Read its file if it isn\'t already loaded.',
    '',
    ...lines,
  ].join('\n');
}

/** `text` kept whole (a Windows checkout gives the shipped file CRLF line ends), a blank line, then `section`. */
export function appendSection(text: string, section: string): string {
  const base = /\n$/.test(text) ? text : `${text}\n`;
  return `${base}\n${section}\n`;
}

/** A plain folder name from a manifest: never the folder itself or anything outside it. */
function plainName(name: unknown): name is string {
  return typeof name === 'string' && !!name && name === path.basename(name) && name !== '.' && name !== '..';
}

async function listedIn(root: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, MANAGED_SKILLS_MANIFEST), 'utf-8'));
    return Array.isArray(raw?.skills) ? raw.skills.filter(plainName) : [];
  } catch {
    // telemetry-exempt: Clubhouse wrote no skills here yet
    return [];
  }
}

/**
 * Remove the skills Clubhouse wrote to a folder, except `keep`: exactly the
 * folders its manifest lists. Nothing else in the folder is touched.
 */
async function removeWritten(root: string, keep: ReadonlySet<string>): Promise<void> {
  const listed = await listedIn(root);
  if (listed.length === 0) return;
  for (const name of listed) {
    if (!keep.has(name)) await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }
  if (keep.size === 0) await fsp.rm(path.join(root, MANAGED_SKILLS_MANIFEST), { force: true });
}

/**
 * Write the role's skills into the CLI's skills folder in `dir`, replacing
 * what an older app version wrote, and remove skills Clubhouse wrote there
 * that this version no longer ships. `others` are every provider's
 * conventions: skills written for a CLI the agent used before are removed from
 * that CLI's folder, since another CLI may read it too (Copilot reads Codex's).
 */
export async function writeDispatcherSkills(
  dir: string,
  role: DispatcherRole,
  conventions: SkillsConventions,
  others: readonly SkillsConventions[] = [],
): Promise<void> {
  const current = skillsFolderOf(conventions);
  const stale = new Set<string>();
  for (const other of [conventions, ...others]) {
    for (const rel of [skillsFolderOf(other), ...(other.previousSkillsRoots ?? [])]) if (rel !== current) stale.add(rel);
  }
  for (const rel of stale) await removeWritten(path.join(dir, rel), new Set());

  const skills = dispatcherSkills(role);
  const root = path.join(dir, current);
  await removeWritten(root, new Set(skills.map((s) => s.name)));
  for (const skill of skills) {
    const folder = path.join(root, skill.name);
    // Whole folder, so a file a skill no longer has doesn't linger.
    await fsp.rm(folder, { recursive: true, force: true });
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, 'SKILL.md'), skill.text, 'utf-8');
  }
  await fsp.writeFile(path.join(root, MANAGED_SKILLS_MANIFEST), `${JSON.stringify({ skills: skills.map((s) => s.name) }, null, 2)}\n`, 'utf-8');
}

/** What an agent's instructions file holds before memory: Clubhouse's instructions, then its skills. */
export function instructionsWithSkills(base: string, role: DispatcherRole, conventions: SkillsConventions | undefined): string {
  return conventions ? appendSection(base, skillsSection(role, conventions)) : base;
}
