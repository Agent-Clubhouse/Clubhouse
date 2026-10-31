import type { AvailableCommand, ChatEvent, ContentBlock } from '../../shared/chat';

/** The last segment of a POSIX or Windows path. */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/**
 * A user message's block as Annex clients see it (#2453): an image keeps
 * its type, size and `mediaRef` (readable through `/mobile/agents/:id/content`)
 * and a file its name. Absolute desktop paths and inline base64 never leave
 * the desktop; `path` becomes the bare file name, which is all a remote
 * client can show.
 */
function remoteBlock(block: ContentBlock): ContentBlock {
  if (block.type === 'file') return { type: 'file', path: baseName(block.path) };
  if (block.type !== 'image') return block;
  return {
    type: 'image', mimeType: block.mimeType,
    ...(block.mediaRef && { mediaRef: block.mediaRef }),
    ...(block.width && block.height && { width: block.width, height: block.height }),
    ...(block.path && { path: baseName(block.path) }),
    ...(block.uri && /^https?:\/\//i.test(block.uri) && { uri: block.uri }),
  };
}

/** The most slash commands a phone is sent; a session with more lists the first ones. */
export const MOBILE_SLASH_COMMANDS_MAX = 200;
const SLASH_NAME_MAX = 64;
const SLASH_DESCRIPTION_MAX = 160;
const SLASH_HINT_MAX = 64;

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The composer's slash commands as a phone sees them: names, a short
 * description and argument hint, and `startOnly`. Bounded so a session with
 * hundreds of skills and long descriptions stays a small message. A name too
 * long to type is left out rather than cut, since a cut name wouldn't run.
 */
export function remoteSlashCommands(commands: readonly AvailableCommand[]): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const c of commands) {
    if (out.length >= MOBILE_SLASH_COMMANDS_MAX) break;
    if (typeof c?.name !== 'string' || !c.name || c.name.length > SLASH_NAME_MAX || /\s/.test(c.name)) continue;
    const description = clip(c.description, SLASH_DESCRIPTION_MAX);
    const inputHint = clip(c.inputHint, SLASH_HINT_MAX);
    out.push({ name: c.name, ...(description && { description }), ...(inputHint && { inputHint }), ...(c.startOnly && { startOnly: true }) });
  }
  return out;
}

/** The session's slash commands: the last `commands_available` in `events`, bounded. */
export function latestSlashCommands(events: readonly ChatEvent[]): AvailableCommand[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'commands_available') return remoteSlashCommands(e.data.commands ?? []);
  }
  return [];
}

/** `event` as broadcast to Annex clients and returned in mobile chat snapshots. Other event types pass through unchanged. */
export function remoteChatEvent(event: ChatEvent): ChatEvent {
  if (event.type === 'commands_available') return { ...event, data: { ...event.data, commands: remoteSlashCommands(event.data.commands ?? []) } };
  if (event.type !== 'user_message' || !event.data.content.some((b) => b.type === 'image' || b.type === 'file')) return event;
  return { ...event, data: { ...event.data, content: event.data.content.map(remoteBlock) } };
}
