import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as http from 'http';
import { CHAT_IMAGE_MAX_BYTES, MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';

vi.mock('./agent-runtime/chat-attachments', () => ({
  STAGED_TTL_MS: 24 * 60 * 60 * 1000,
  stageAttachmentData: vi.fn(),
  resolveAttachments: vi.fn(),
}));

import { resolveAttachments, stageAttachmentData } from './agent-runtime/chat-attachments';
import {
  MOBILE_ATTACHMENTS_CAPABILITY, MOBILE_UPLOAD_QUOTA, MOBILE_UPLOAD_RATE, MobileAttachmentService, MobileUploadError,
  isUploadContentType, readCappedBody,
} from './mobile-attachments';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 7, 0, 0, 0, 9, 8, 6, 0, 0, 0]);
const caps = { ...MINIMAL_CHAT_CAPABILITIES, images: true };

function fakeRequest(chunks: Buffer[], headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { headers, pause: vi.fn() });
  queueMicrotask(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
  return req as unknown as http.IncomingMessage & { pause: ReturnType<typeof vi.fn> };
}

let clock = 1_000_000;
let service: MobileAttachmentService;
let nextId = 0;
beforeEach(() => {
  clock = 1_000_000;
  nextId = 0;
  vi.mocked(stageAttachmentData).mockReset().mockImplementation(async (_agent, data) => {
    if (data[0] !== 0x89) throw new Error('Only PNG, JPEG, GIF or WebP images can be pasted');
    return { id: `id-${++nextId}`, name: 'phone-image', kind: 'image', mimeType: 'image/png', size: data.byteLength, pasted: true };
  });
  vi.mocked(resolveAttachments).mockReset().mockResolvedValue([{ type: 'image', mimeType: 'image/png', path: '/staged.png' }]);
  service = new MobileAttachmentService(() => clock);
});

describe('readCappedBody', () => {
  it('returns the body within the cap', async () => {
    expect(await readCappedBody(fakeRequest([Buffer.from('ab'), Buffer.from('cd')]), 4)).toEqual(Buffer.from('abcd'));
  });
  it('refuses a declared Content-Length over the cap without reading', async () => {
    const req = fakeRequest([], { 'content-length': String(CHAT_IMAGE_MAX_BYTES + 1) });
    await expect(readCappedBody(req, CHAT_IMAGE_MAX_BYTES)).rejects.toMatchObject({ code: 'too_large', statusCode: 413 });
    expect(req.listenerCount('data')).toBe(0);
  });
  it('stops a body that streams past the cap', async () => {
    const req = fakeRequest([Buffer.alloc(3), Buffer.alloc(3)]);
    await expect(readCappedBody(req, 5)).rejects.toBeInstanceOf(MobileUploadError);
    expect(req.pause).toHaveBeenCalled();
    expect(req.listenerCount('data')).toBe(0);
  });
});

describe('isUploadContentType', () => {
  it('takes the supported image types and raw bytes only', () => {
    for (const t of ['image/png', 'image/jpeg; charset=binary', 'IMAGE/WEBP', 'application/octet-stream']) expect(isUploadContentType(t)).toBe(true);
    for (const t of [undefined, '', 'application/json', 'multipart/form-data; boundary=x', 'image/svg+xml']) expect(isUploadContentType(t)).toBe(false);
  });
});

describe('MobileAttachmentService', () => {
  it('stages through stageAttachmentData and reports the sniffed type, size and dimensions', async () => {
    expect(await service.upload('phone', 'agent', PNG)).toEqual({ version: 1, attachmentId: 'id-1', mimeType: 'image/png', bytes: PNG.byteLength, width: 7, height: 9 });
    expect(stageAttachmentData).toHaveBeenCalledWith('agent', PNG, 'phone-image');
  });

  it('refuses empty, oversized and non-image bodies', async () => {
    await expect(service.upload('phone', 'agent', new Uint8Array())).rejects.toMatchObject({ code: 'empty_body', statusCode: 400 });
    await expect(service.upload('phone', 'agent', new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'too_large', statusCode: 413 });
    await expect(service.upload('phone', 'agent', new TextEncoder().encode('<svg/>'))).rejects.toMatchObject({ code: 'unsupported_image', statusCode: 415 });
  });

  it('rate-limits each peer separately and says when to retry', async () => {
    for (let i = 0; i < MOBILE_UPLOAD_RATE.max; i++) await service.upload('phone', 'agent', PNG);
    clock += 10_000;
    const err = await service.upload('phone', 'agent', PNG).catch((e) => e);
    expect(err).toMatchObject({ code: 'rate_limited', statusCode: 429, retryAfterMs: MOBILE_UPLOAD_RATE.windowMs - 10_000 });
    await expect(service.upload('other-phone', 'agent', PNG)).resolves.toMatchObject({ attachmentId: expect.any(String) });
    clock += MOBILE_UPLOAD_RATE.windowMs;
    await expect(service.upload('phone', 'agent', PNG)).resolves.toMatchObject({ attachmentId: expect.any(String) });
  });

  it('enforces a daily upload and byte quota per peer', async () => {
    for (let i = 0; i < MOBILE_UPLOAD_QUOTA.maxUploads; i++) {
      await service.upload('phone', 'agent', PNG);
      clock += MOBILE_UPLOAD_RATE.windowMs; // stay under the short-term rate
    }
    await expect(service.upload('phone', 'agent', PNG)).rejects.toMatchObject({ code: 'quota_exceeded', statusCode: 429 });
    clock += MOBILE_UPLOAD_QUOTA.windowMs;
    await expect(service.upload('phone', 'agent', PNG)).resolves.toBeDefined();
    const bytes = new MobileAttachmentService(() => clock);
    expect(() => bytes.checkLimits('phone', MOBILE_UPLOAD_QUOTA.maxBytes + 1)).toThrow(MobileUploadError);
  });

  it('only resolves ids the same peer uploaded for the same agent', async () => {
    const { attachmentId } = await service.upload('phone', 'agent', PNG);
    expect(await service.resolveFor('phone', 'agent', [attachmentId], caps)).toEqual([{ type: 'image', mimeType: 'image/png', path: '/staged.png' }]);
    expect(resolveAttachments).toHaveBeenCalledWith('agent', [attachmentId], caps);
    await expect(service.resolveFor('other-phone', 'agent', [attachmentId], caps)).rejects.toThrow();
    await expect(service.resolveFor('phone', 'other-agent', [attachmentId], caps)).rejects.toThrow();
    // A desktop composer id the phone never uploaded.
    await expect(service.resolveFor('phone', 'agent', [attachmentId, 'desktop-draft-id'], caps)).rejects.toThrow();
    expect(resolveAttachments).toHaveBeenCalledTimes(1);
    service.reset();
    await expect(service.resolveFor('phone', 'agent', [attachmentId], caps)).rejects.toThrow();
  });

  it('advertises the desktop image limits', () => {
    expect(MOBILE_ATTACHMENTS_CAPABILITY).toEqual({ version: 1, imageTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], maxImageBytes: 3932160, maxCount: 10 });
  });
});
