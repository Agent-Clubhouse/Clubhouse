import type { ChatEvent, ContentBlock } from '../../shared/chat';

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

/** `event` as broadcast to Annex clients and returned in mobile chat snapshots. Other event types pass through unchanged. */
export function remoteChatEvent(event: ChatEvent): ChatEvent {
  if (event.type !== 'user_message' || !event.data.content.some((b) => b.type === 'image' || b.type === 'file')) return event;
  return { ...event, data: { ...event.data, content: event.data.content.map(remoteBlock) } };
}
