/**
 * Phone image uploads (#2453): POST /api/v1/mobile/agents/:id/attachments.
 *
 * The phone sends raw image bytes; they go through the composer's own
 * staging (stageAttachmentData: byte sniffing, the 3.75 MB cap, storage
 * under `<userData>/chat-attachments/<agent>/`) and the phone gets an opaque
 * id back to put in chat.send's `attachmentIds`. Ids are bound to the peer
 * that uploaded them, so one phone can't send another's (or a desktop
 * draft's) staged files.
 *
 * Each peer gets a short-term rate limit and a daily quota of uploads and
 * bytes. The daily window matches how long a staged id lives, so one peer
 * can never hold more than a share of the staging slots.
 */

import type * as http from 'http';
import type { ChatCapabilities, ContentBlock } from '../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, mediaDimensions } from '../../shared/chat';
import { resolveAttachments, stageAttachmentData, STAGED_TTL_MS } from './agent-runtime/chat-attachments';

export const MOBILE_UPLOAD_RATE = { max: 20, windowMs: 60 * 1000 };
export const MOBILE_UPLOAD_QUOTA = { maxUploads: 200, maxBytes: 256 * 1024 * 1024, windowMs: STAGED_TTL_MS };
/** Raw image bodies only; the bytes decide the type, this just catches a JSON or form body sent by mistake. */
const UPLOAD_CONTENT_TYPES = [...CHAT_IMAGE_TYPES, 'application/octet-stream'];

/** What `/mobile/capabilities` advertises as `attachments`. */
export const MOBILE_ATTACHMENTS_CAPABILITY = {
  version: 1, imageTypes: [...CHAT_IMAGE_TYPES], maxImageBytes: CHAT_IMAGE_MAX_BYTES, maxCount: CHAT_ATTACHMENTS_MAX,
} as const;

export class MobileUploadError extends Error {
  constructor(readonly code: string, readonly statusCode: number, readonly retryAfterMs?: number) { super(code); }
}

export interface MobileUploadResult {
  version: 1;
  attachmentId: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

/**
 * The request body, refusing more than `max` bytes. A declared
 * Content-Length over the cap is refused before anything is read; a body
 * that streams past it stops being read. Either way the caller answers 413
 * and closes the connection (`Connection: close`), so the rest is never read.
 */
export function readCappedBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return Promise.reject(new MobileUploadError('too_large', 413));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.off('data', onData);
        req.pause();
        reject(new MobileUploadError('too_large', 413));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Upload { at: number; bytes: number }
interface Owned { principal: string; agentId: string; at: number }

/** Per-peer limits and ownership of uploaded ids. In memory: staged ids don't survive a restart either. */
export class MobileAttachmentService {
  private readonly uploads = new Map<string, Upload[]>();
  private readonly owned = new Map<string, Owned>();

  constructor(
    private readonly now = Date.now,
    private readonly stage: typeof stageAttachmentData = stageAttachmentData,
    private readonly resolve: typeof resolveAttachments = resolveAttachments,
  ) {}

  reset(): void { this.uploads.clear(); this.owned.clear(); }

  /** Refuses (429) when `principal` is over its rate or quota; call before reading the body. */
  checkLimits(principal: string, incomingBytes = 0): void {
    const now = this.now();
    const recent = (this.uploads.get(principal) ?? []).filter((u) => now - u.at < MOBILE_UPLOAD_QUOTA.windowMs);
    this.uploads.set(principal, recent);
    const inWindow = recent.filter((u) => now - u.at < MOBILE_UPLOAD_RATE.windowMs);
    if (inWindow.length >= MOBILE_UPLOAD_RATE.max) {
      throw new MobileUploadError('rate_limited', 429, inWindow[0].at + MOBILE_UPLOAD_RATE.windowMs - now);
    }
    const bytes = recent.reduce((sum, u) => sum + u.bytes, 0);
    if (recent.length >= MOBILE_UPLOAD_QUOTA.maxUploads || bytes + incomingBytes > MOBILE_UPLOAD_QUOTA.maxBytes) {
      throw new MobileUploadError('quota_exceeded', 429, (recent[0]?.at ?? now) + MOBILE_UPLOAD_QUOTA.windowMs - now);
    }
  }

  /** Stage an uploaded image for `agentId` on behalf of `principal`. */
  async upload(principal: string, agentId: string, data: Uint8Array): Promise<MobileUploadResult> {
    this.checkLimits(principal, data.byteLength);
    if (!data.byteLength) throw new MobileUploadError('empty_body', 400);
    if (data.byteLength > CHAT_IMAGE_MAX_BYTES) throw new MobileUploadError('too_large', 413);
    // Counted before staging: a refused (non-image) body still used the peer's allowance.
    this.uploads.get(principal)!.push({ at: this.now(), bytes: data.byteLength });
    let staged;
    try { staged = await this.stage(agentId, data, 'phone-image'); }
    catch { // telemetry-exempt: the bytes weren't a supported image; the caller gets a bounded error, nothing is logged.
      throw new MobileUploadError('unsupported_image', 415); }
    const now = this.now();
    for (const [id, o] of this.owned) if (now - o.at > STAGED_TTL_MS) this.owned.delete(id);
    this.owned.set(staged.id, { principal, agentId, at: now });
    const size = staged.mimeType ? mediaDimensions(data, staged.mimeType) : undefined;
    return { version: 1, attachmentId: staged.id, mimeType: staged.mimeType!, bytes: staged.size, ...(size && { width: size.width, height: size.height }) };
  }

  /** Content blocks for ids `principal` uploaded for `agentId`; anything else throws. */
  async resolveFor(principal: string, agentId: string, ids: string[], caps: ChatCapabilities | undefined): Promise<ContentBlock[]> {
    for (const id of ids) {
      const o = this.owned.get(id);
      if (!o || o.principal !== principal || o.agentId !== agentId) throw new Error('Unknown attachment');
    }
    return this.resolve(agentId, ids, caps);
  }
}

/** Content-Type must name a supported image or raw bytes (parameters ignored). */
export function isUploadContentType(header: string | undefined): boolean {
  const type = header?.split(';')[0].trim().toLowerCase();
  return !!type && UPLOAD_CONTENT_TYPES.includes(type);
}
