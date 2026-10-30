import { isMediaRef } from '../../shared/chat';
import { readMedia } from './agent-runtime/chat-media';
import { readChatFilePreview } from './agent-runtime/chat-files';

/** Base64 plus metadata stays below mobile's 16 MiB HTTP response cap. */
export const MOBILE_CONTENT_MAX_BYTES = 8 * 1024 * 1024;

/** No URLs or shell actions. The desktop preview policy resolves the path
 * (symlinks included) and performs the regular-file, type and size checks. */
export async function readMobileChatContent(query: URLSearchParams, agentId: string, enabled: () => boolean) {
  if (!enabled()) throw new Error('Rich content disabled');
  const mediaRef = query.get('mediaRef');
  const filePath = query.get('path');
  if ([...query.keys()].some((key) => key !== 'mediaRef' && key !== 'path')
    || query.getAll('mediaRef').length > 1 || query.getAll('path').length > 1
    || (mediaRef !== null) === (filePath !== null)) throw new Error('Invalid content request');
  if (mediaRef !== null && !isMediaRef(mediaRef)) throw new Error('Invalid reference');
  if (filePath !== null && (!filePath || filePath.length > 1024)) throw new Error('Invalid path');
  const content = mediaRef !== null
    ? { kind: 'image', name: mediaRef, ...await readMedia(agentId, mediaRef) }
    : await readChatFilePreview(agentId, filePath!);
  if (!enabled()) throw new Error('Rich content disabled');
  const { data, ...metadata } = content;
  if (data && data.byteLength > MOBILE_CONTENT_MAX_BYTES) return { ...metadata, tooLarge: true };
  return { ...metadata, ...(data ? { base64: Buffer.from(data).toString('base64') } : {}) };
}
