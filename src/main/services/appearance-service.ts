/**
 * Project and agent appearance (#2597): color, emoji, image and a project's
 * display name, and nothing else. The update_project and update_agent MCP tools
 * sit on this, and so will the clubhouse CLI (#2598), so it knows nothing about
 * MCP. Every field is checked before anything is written. The stores tell the
 * windows, so the UI follows without a restart.
 *
 * Who can change what:
 * - An agent changes itself and its own project.
 * - The Dispatcher and the CLI change any project or agent.
 * - The Dispatcher's own appearance is locked for everyone.
 *
 * All of it is display only, so it changes at any time, awake or asleep. The
 * Settings card and agent.update still lock an agent's while it is awake. An
 * agent's name isn't here: it has one name field, and a rename leaves the
 * worktree and branch behind, so the name and path drift apart.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { CHAT_MEDIA_TYPES, sniffMediaType } from '../../shared/chat';
import { ICON_FILE_MAX_BYTES } from '../../shared/icon-limits';
import { AGENT_COLORS } from '../../shared/name-generator';
import type { DurableAgentConfig, Project } from '../../shared/types';
import * as agentConfig from './agent-config';
import { resolveLocalPath } from './agent-runtime/chat-media';
import { isDispatcherPath } from './dispatcher/dispatcher-paths';
import { isDispatcherAgentId } from './dispatcher/dispatcher-service';
import { appLog } from './log-service';
import * as projectStore from './project-store';

export type AppearanceErrorCode =
  | 'out_of_scope' | 'not_found' | 'ambiguous_project' | 'no_changes' | 'dispatcher_locked' | 'agent_creating'
  | 'invalid_name' | 'invalid_color' | 'invalid_emoji' | 'invalid_image' | 'conflicting_icon';

/** A refused change. The message says why, for the caller to show as is. */
export class AppearanceError extends Error {
  constructor(readonly code: AppearanceErrorCode, message: string) {
    super(message);
    this.name = 'AppearanceError';
  }
}

/** Who is asking. `cwd` is what a relative image path resolves against. */
export type AppearanceActor =
  /** An agent: itself and its own project. */
  | { scope: 'own'; agentId: string; projectPath: string; cwd?: string }
  /** The Dispatcher (with its agentId) or the CLI: any project or agent. */
  | { scope: 'all'; agentId?: string; cwd?: string };

/** For each field, undefined leaves it alone and '' clears it. */
export interface ProjectAppearanceUpdates {
  displayName?: string;
  color?: string;
  emoji?: string;
  /** Path of an image file. */
  imagePath?: string;
}

/** For each field, undefined leaves it alone. An agent always has a color; '' clears the others. */
export interface AgentAppearanceUpdates {
  color?: string;
  emoji?: string;
  /** Path of an image file. */
  imagePath?: string;
}

export interface ProjectAppearance {
  id: string;
  name: string;
  path: string;
  displayName: string | null;
  color: string | null;
  emoji: string | null;
  hasImage: boolean;
}

export interface AgentAppearance {
  id: string;
  name: string;
  color: string;
  emoji: string | null;
  hasImage: boolean;
}

/** agent.update's caps on this kind of text. */
const NAME_MAX_LENGTH = 256;
const EMOJI_MAX_LENGTH = 16;

function assertColor(color: string): void {
  if (!AGENT_COLORS.some((c) => c.id === color)) {
    throw new AppearanceError('invalid_color', `"${color}" isn't a color. Use one of: ${AGENT_COLORS.map((c) => c.id).join(', ')}.`);
  }
}

function assertEmoji(emoji: string): void {
  if (emoji.length > EMOJI_MAX_LENGTH) throw new AppearanceError('invalid_emoji', 'That emoji is too long. Use a single emoji.');
}

/** An emoji and an image can't both show: each clears the other. */
function assertOneIcon(emoji: string | undefined, imagePath: string | undefined): void {
  if (emoji && imagePath) throw new AppearanceError('conflicting_icon', 'Set an emoji or an image, not both.');
}

function imageError(imagePath: string, why: string): AppearanceError {
  return new AppearanceError('invalid_image', `Can't use the image ${imagePath}: ${why}`);
}

const IMAGE_TYPES = Object.values(CHAT_MEDIA_TYPES).join(', ');

/** An image file's bytes and type, from the bytes themselves. It may be anywhere the user can read (#2478). */
async function readImage(imagePath: string, cwd: string | undefined): Promise<{ bytes: Buffer; extension: string }> {
  const real = await resolveLocalPath(imagePath, cwd);
  if (!real) throw imageError(imagePath, cwd ? 'the file doesn\'t exist.' : 'the file doesn\'t exist, or the path isn\'t absolute.');
  // One handle for the check and the read, and non-blocking so a FIFO can't stall the app.
  const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)).catch((err: unknown) => {
    throw imageError(imagePath, `the file can't be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  });
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw imageError(imagePath, 'it isn\'t a file.');
    if (stat.size > ICON_FILE_MAX_BYTES) throw imageError(imagePath, `it's larger than ${(ICON_FILE_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB.`);
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0).catch((err: unknown) => {
      throw imageError(imagePath, `the file can't be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    });
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const extension = CHAT_MEDIA_TYPES[sniffMediaType(bytes) ?? ''];
  if (!extension) throw imageError(imagePath, `it isn't a supported image (${IMAGE_TYPES}).`);
  return { bytes, extension };
}

function describeProject(project: Project): ProjectAppearance {
  return {
    id: project.id, name: project.name, path: project.path,
    displayName: project.displayName ?? null, color: project.color ?? null, emoji: project.emoji ?? null, hasImage: !!project.icon,
  };
}

function describeAgent(config: DurableAgentConfig): AgentAppearance {
  return { id: config.id, name: config.name, color: config.color, emoji: config.emoji ?? null, hasImage: !!config.icon };
}

async function findOwnProject(projects: readonly Project[], projectPath: string): Promise<Project | undefined> {
  for (const project of projects) {
    if (await agentConfig.isSameProject(project.path, projectPath)) return project;
  }
  return undefined;
}

/** A project by id, path or name, as list_projects shows them. */
async function findProject(projects: readonly Project[], ref: string): Promise<Project> {
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const byPath = await findOwnProject(projects, ref);
  if (byPath) return byPath;
  const byName = projects.filter((p) => (p.displayName || p.name) === ref);
  if (byName.length > 1) throw new AppearanceError('ambiguous_project', `More than one project is called "${ref}". Use its path.`);
  if (byName.length === 0) throw new AppearanceError('not_found', `No project matches "${ref}".`);
  return byName[0];
}

/** The project this change is for, within the actor's scope. `ref` defaults to an agent's own project. */
async function resolveProject(actor: AppearanceActor, ref: string | undefined): Promise<Project> {
  const projects = await projectStore.list();
  if (actor.scope === 'all') {
    if (!ref) throw new AppearanceError('not_found', 'Say which project to change.');
    return findProject(projects, ref);
  }
  const own = await findOwnProject(projects, actor.projectPath);
  if (!own) throw new AppearanceError('not_found', 'You aren\'t in a registered project.');
  if (ref && ref !== own.id && (await findProject(projects, ref)).id !== own.id) {
    throw new AppearanceError('out_of_scope', 'You can only change your own project.');
  }
  return own;
}

/** Every project, as it looks now. */
export async function listProjectAppearances(): Promise<ProjectAppearance[]> {
  return (await projectStore.list()).map(describeProject);
}

/** Every agent, in one project or all of them. The Dispatcher is in none. */
export async function listAgentAppearances(projectRef?: string): Promise<Array<AgentAppearance & { projectId: string }>> {
  const projects = await projectStore.list();
  const targets = projectRef ? [await findProject(projects, projectRef)] : projects;
  const rows: Array<AgentAppearance & { projectId: string }> = [];
  for (const project of targets) {
    let agents: DurableAgentConfig[];
    try {
      agents = await agentConfig.listDurable(project.path);
    } catch (err) {
      // telemetry-exempt: logged; one unreadable project must not hide the others
      appLog('core:cli', 'warn', 'Could not list a project\'s agents', {
        meta: { projectPath: project.path, error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }
    for (const agent of agents) {
      if (!isDisposedAgent(agent)) rows.push({ ...describeAgent(agent), projectId: project.id });
    }
  }
  return rows;
}

export async function updateProjectAppearance(
  actor: AppearanceActor,
  projectRef: string | undefined,
  updates: ProjectAppearanceUpdates,
): Promise<ProjectAppearance> {
  const project = await resolveProject(actor, projectRef);
  const { color, emoji, imagePath } = updates;
  const displayName = updates.displayName?.trim();
  if (displayName === undefined && color === undefined && emoji === undefined && imagePath === undefined) {
    throw new AppearanceError('no_changes', 'Nothing to change: set a display name, color, emoji or image.');
  }
  if (displayName !== undefined && displayName.length > NAME_MAX_LENGTH) {
    throw new AppearanceError('invalid_name', `Keep the display name to ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  if (color) assertColor(color);
  if (emoji) assertEmoji(emoji);
  assertOneIcon(emoji, imagePath);
  const image = imagePath ? await readImage(imagePath, actor.cwd) : undefined;

  const write: Parameters<typeof projectStore.update>[1] = {};
  if (displayName !== undefined) write.displayName = displayName;
  if (color !== undefined) write.color = color;
  if (emoji !== undefined) write.emoji = emoji;
  if (image) {
    write.icon = await projectStore.writeIconFile(project.id, image.bytes, image.extension);
    write.emoji = '';
  } else if (imagePath === '') {
    write.icon = '';
  }
  const saved = (await projectStore.update(project.id, write)).find((p) => p.id === project.id);
  if (!saved) throw new AppearanceError('not_found', 'That project was just removed.');
  return describeProject(saved);
}

/** The agent this change is for, within the actor's scope. `agentId` defaults to the actor itself. */
async function resolveAgent(actor: AppearanceActor, agentId: string | undefined): Promise<{ projectPath: string; config: DurableAgentConfig }> {
  const id = agentId ?? actor.agentId;
  if (!id) throw new AppearanceError('not_found', 'Say which agent to change.');
  if (actor.scope === 'own' && id !== actor.agentId) throw new AppearanceError('out_of_scope', 'You can only change yourself.');
  if (isDispatcherAgentId(id) || (id === actor.agentId && actor.scope === 'own' && isDispatcherPath(actor.projectPath))) {
    throw new AppearanceError('dispatcher_locked', 'The Dispatcher\'s appearance can\'t be changed.');
  }
  const projectPaths = actor.scope === 'own' ? [actor.projectPath] : (await projectStore.list()).map((p) => p.path);
  for (const projectPath of projectPaths) {
    const config = await agentConfig.getDurableConfig(projectPath, id);
    if (config && !isDisposedAgent(config)) return { projectPath, config };
  }
  throw new AppearanceError('not_found', actor.scope === 'own' ? 'Only durable agents have a saved appearance.' : `No agent has the id "${id}".`);
}

export async function updateAgentAppearance(
  actor: AppearanceActor,
  agentId: string | undefined,
  updates: AgentAppearanceUpdates,
): Promise<AgentAppearance> {
  const { projectPath, config } = await resolveAgent(actor, agentId);
  const { color, emoji, imagePath } = updates;
  if (color === undefined && emoji === undefined && imagePath === undefined) {
    throw new AppearanceError('no_changes', 'Nothing to change: set a color, emoji or image.');
  }
  // Creation writes the agent's record as it goes.
  if (config.creation?.state === 'creating') throw new AppearanceError('agent_creating', 'The agent is still being created.');
  if (color !== undefined) assertColor(color);
  if (emoji) assertEmoji(emoji);
  assertOneIcon(emoji, imagePath);
  const image = imagePath ? await readImage(imagePath, actor.cwd) : undefined;

  const write: Parameters<typeof agentConfig.updateDurable>[2] = {};
  if (color !== undefined) write.color = color;
  if (emoji !== undefined) write.emoji = emoji || null;
  if (image) {
    write.icon = await agentConfig.writeAgentIconFile(config.id, image.bytes, image.extension);
    write.emoji = null;
  } else if (imagePath === '') {
    write.icon = null;
  }
  await agentConfig.updateDurable(projectPath, config.id, write);
  // The file goes once nothing points at it: an emoji replaced the image, or it was cleared.
  if (emoji || imagePath === '') await agentConfig.removeAgentIconFile(config.id);
  return describeAgent((await agentConfig.getDurableConfig(projectPath, config.id)) ?? config);
}
