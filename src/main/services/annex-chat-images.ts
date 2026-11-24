/** Desktop remote chat images over the existing pinned mobile routes (#2398).
 * This seam accepts refs or bytes only; it never accepts a filesystem path or URL. */
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, CHAT_MEDIA_TYPES, isMediaRef, sniffMediaType } from '../../shared/chat';
import { MOBILE_CONTENT_MAX_BASE64, MOBILE_CONTENT_MAX_BYTES } from '../../shared/annex-binary-limits';

export interface ChatImageRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Buffer;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface ChatImageResponse { status: number; body: Buffer }
export type ChatImageTransport = (machine: string, input: ChatImageRequest) => Promise<ChatImageResponse>;
export interface RemoteImageUpload { attachmentId: string; mimeType: string; bytes: number }
const METADATA_MAX_BYTES = 64 * 1024;
const MEDIA_RESPONSE_MAX_BYTES = MOBILE_CONTENT_MAX_BASE64 + METADATA_MAX_BYTES;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid image response from the other computer');
  return value as Record<string, unknown>;
}
function json(response: ChatImageResponse, max: number): Record<string, unknown> {
  if (response.body.byteLength > max) throw new Error('Image response exceeds its byte limit');
  if (response.status !== 200) {
    // Never echo an arbitrary server body (which could contain paths or private text).
    throw new Error(`The other computer refused the image request (HTTP ${response.status})`);
  }
  try { return object(JSON.parse(response.body.toString('utf8'))); }
  catch { throw new Error('Invalid image response from the other computer'); } // telemetry-exempt: never echo response bytes
}
function target(machine: string, agentId: string): void {
  if (!machine || machine.length > 256 || !agentId || agentId.length > 256 || /[\0\r\n]/.test(machine + agentId)) throw new Error('Invalid remote image target');
}
async function capabilities(request: ChatImageTransport, machine: string): Promise<Record<string, unknown>> {
  return json(await request(machine, { method: 'GET', path: '/api/v1/mobile/capabilities', timeoutMs: 30_000, maxResponseBytes: METADATA_MAX_BYTES }), METADATA_MAX_BYTES);
}

export async function readRemoteChatMedia(request: ChatImageTransport, machine: string, agentId: string, mediaRef: string): Promise<{ mimeType: string; data: Uint8Array }> {
  target(machine, agentId);
  if (!isMediaRef(mediaRef)) throw new Error('Not a media reference');
  const caps = await capabilities(request, machine);
  const rich = object(caps.richContent);
  if (rich.version !== 1 || rich.enabled !== true || !Number.isSafeInteger(rich.maximumBytes) || Number(rich.maximumBytes) <= 0) throw new Error('Chat images are unavailable on the other computer');
  const maximum = Math.min(Number(rich.maximumBytes), MOBILE_CONTENT_MAX_BYTES);
  const response = json(await request(machine, {
    method: 'GET', path: `/api/v1/mobile/agents/${encodeURIComponent(agentId)}/content?mediaRef=${encodeURIComponent(mediaRef)}`,
    timeoutMs: 30_000, maxResponseBytes: MEDIA_RESPONSE_MAX_BYTES,
  }), MEDIA_RESPONSE_MAX_BYTES);
  if (response.tooLarge === true) throw new Error('This image is too large to show from another computer');
  if (response.kind !== 'image' || response.name !== mediaRef || typeof response.mimeType !== 'string' || !Object.prototype.hasOwnProperty.call(CHAT_MEDIA_TYPES, response.mimeType)) throw new Error('Invalid image response from the other computer');
  const encoded = response.base64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > MOBILE_CONTENT_MAX_BASE64 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid image bytes from the other computer');
  const data = Buffer.from(encoded, 'base64');
  if (data.byteLength > maximum || data.toString('base64') !== encoded || sniffMediaType(data) !== response.mimeType) throw new Error('Invalid image bytes from the other computer');
  return { mimeType: response.mimeType, data: new Uint8Array(data) };
}

export async function uploadRemoteChatImage(request: ChatImageTransport, machine: string, agentId: string, data: Uint8Array): Promise<RemoteImageUpload> {
  target(machine, agentId);
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > CHAT_IMAGE_MAX_BYTES) throw new Error('Images must be nonempty and 3.75 MB or smaller');
  const body = Buffer.from(data);
  const mimeType = sniffMediaType(body);
  if (!mimeType || !CHAT_IMAGE_TYPES.includes(mimeType)) throw new Error('Remote chats take PNG, JPEG, GIF or WebP images only');
  const caps = object((await capabilities(request, machine)).attachments);
  if (caps.version !== 1 || !Array.isArray(caps.imageTypes) || !caps.imageTypes.includes(mimeType)
    || !Number.isSafeInteger(caps.maxImageBytes) || Number(caps.maxImageBytes) < data.byteLength
    || !Number.isSafeInteger(caps.maxCount) || Number(caps.maxCount) < 1) throw new Error('Image attachments are unavailable on the other computer');
  const result = json(await request(machine, {
    method: 'POST', path: `/api/v1/mobile/agents/${encodeURIComponent(agentId)}/attachments`,
    body, headers: { 'content-type': mimeType }, timeoutMs: 30_000, maxResponseBytes: METADATA_MAX_BYTES,
  }), METADATA_MAX_BYTES);
  if (result.version !== 1 || typeof result.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.attachmentId)
    || result.mimeType !== mimeType || result.bytes !== data.byteLength) throw new Error('Invalid attachment response from the other computer');
  return { attachmentId: result.attachmentId, mimeType, bytes: data.byteLength };
}
