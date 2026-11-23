import { describe, expect, it, vi } from 'vitest';
import { CHAT_IMAGE_MAX_BYTES } from '../../shared/chat';
import { MOBILE_CONTENT_MAX_BASE64, MOBILE_CONTENT_MAX_BYTES } from '../../shared/annex-binary-limits';
import { readRemoteChatMedia, uploadRemoteChatImage, type ChatImageTransport } from './annex-chat-images';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const ref = `${'a'.repeat(64)}.png`;
const caps = { richContent: { version: 1, enabled: true, maximumBytes: MOBILE_CONTENT_MAX_BYTES }, attachments: { version: 1, imageTypes: ['image/png'], maxImageBytes: CHAT_IMAGE_MAX_BYTES, maxCount: 10 } };
const reply = (body: unknown, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)) });
const image = { kind: 'image', name: ref, mimeType: 'image/png', base64: png.toString('base64') };
function transport(body: unknown = image) {
  return vi.fn<ChatImageTransport>(async (_host, req) => reply(req.path.endsWith('/capabilities') ? caps : body));
}

describe('remote chat ref/byte-only transport', () => {
  it('reads the exact host/agent/ref with a bounded response and no path metadata', async () => {
    const request = transport({ ...image, sourcePath: '/satellite/private' });
    expect(await readRemoteChatMedia(request, 'host-a', 'agent/with space', ref)).toEqual({ mimeType: 'image/png', data: new Uint8Array(png) });
    expect(request.mock.calls[1]).toEqual(['host-a', { method: 'GET', path: `/api/v1/mobile/agents/agent%2Fwith%20space/content?mediaRef=${ref}`, timeoutMs: 30_000, maxResponseBytes: MOBILE_CONTENT_MAX_BASE64 + 64 * 1024 }]);
    await readRemoteChatMedia(request, 'host-b', 'agent/with space', ref);
    expect(request.mock.calls[3][0]).toBe('host-b');
  });
  it.each(['../../secret', 'A'.repeat(64) + '.png', ref + '?path=/secret', ''])('refuses bad ref before any request: %s', async (value) => {
    const request = transport();
    await expect(readRemoteChatMedia(request, 'host', 'agent', value)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['', 'agent\n'])('refuses invalid target before requests: %s', async (agent) => {
    const request = transport();
    await expect(readRemoteChatMedia(request, 'host', agent, ref)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{}, { richContent: { ...caps.richContent, enabled: false } }, { richContent: { ...caps.richContent, version: 2 } }])('never fetches content without current remote support', async (body) => {
    const request = vi.fn<ChatImageTransport>(async () => reply(body));
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([
    { ...image, tooLarge: true }, { ...image, base64: '!!!!' }, { ...image, base64: 'YQ==' },
    { ...image, base64: 'iVBORw0KGgoBA===' }, { ...image, name: 'other' }, { ...image, mimeType: 'text/html' },
    { ...image, mimeType: 'image/jpeg' }, { ...image, kind: 'text' }, { ...image, base64: 'a'.repeat(MOBILE_CONTENT_MAX_BASE64 + 4) },
  ])('rejects malformed/oversized image instead of falling back locally', async (body) => {
    await expect(readRemoteChatMedia(transport(body), 'host', 'agent', ref)).rejects.toThrow();
  });
  it('enforces decoded and complete response bounds, even if transport violates its budget', async () => {
    const large = Buffer.alloc(MOBILE_CONTENT_MAX_BYTES + 1); png.copy(large);
    await expect(readRemoteChatMedia(transport({ ...image, base64: large.toString('base64') }), 'host', 'agent', ref)).rejects.toThrow();
    const request = vi.fn<ChatImageTransport>(async (_h, req) => req.path.endsWith('capabilities') ? reply(caps) : { status: 200, body: Buffer.alloc(MOBILE_CONTENT_MAX_BASE64 + 64 * 1024 + 1) });
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.toThrow('byte limit');
  });
  it('accepts exactly the remote byte boundary and refuses the advertised smaller boundary', async () => {
    const data = Buffer.alloc(MOBILE_CONTENT_MAX_BYTES); png.copy(data);
    expect((await readRemoteChatMedia(transport({ ...image, base64: data.toString('base64') }), 'host', 'agent', ref)).data.byteLength).toBe(MOBILE_CONTENT_MAX_BYTES);
    const request = vi.fn<ChatImageTransport>(async (_h, req) => reply(req.path.endsWith('capabilities') ? { richContent: { ...caps.richContent, maximumBytes: 8 } } : image));
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.toThrow();
  });
  it('propagates lease/revocation errors and hides arbitrary refusal bodies', async () => {
    const request = transport(); request.mockRejectedValueOnce(new Error('authorization_revoked'));
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.toThrow('authorization_revoked');
    request.mockImplementation(async () => reply({ path: '/private/token' }, 403));
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.toThrow('HTTP 403');
    await expect(readRemoteChatMedia(request, 'host', 'agent', ref)).rejects.not.toThrow('/private');
  });
  it('uploads sniffed raw bytes to the exact peer/agent with the existing limits', async () => {
    const request = transport({ version: 1, attachmentId: 'opaque-uuid', mimeType: 'image/png', bytes: png.length });
    expect(await uploadRemoteChatImage(request, 'host', 'agent/a', new Uint8Array(png))).toEqual({ attachmentId: 'opaque-uuid', mimeType: 'image/png', bytes: png.length });
    expect(request.mock.calls[1]).toEqual(['host', { method: 'POST', path: '/api/v1/mobile/agents/agent%2Fa/attachments', headers: { 'content-type': 'image/png' }, body: png, timeoutMs: 30_000, maxResponseBytes: 64 * 1024 }]);
  });
  it.each([new Uint8Array(), new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1), new Uint8Array([1, 2]), new TextEncoder().encode('<svg/>')])('refuses invalid upload before networking', async (bytes) => {
    const request = transport();
    await expect(uploadRemoteChatImage(request, 'host', 'agent', bytes)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('accepts exactly the upload cap and snapshots bytes before awaiting capabilities', async () => {
    const data = Buffer.alloc(CHAT_IMAGE_MAX_BYTES); png.copy(data);
    const request = transport({ version: 1, attachmentId: 'id', mimeType: 'image/png', bytes: data.length });
    request.mockImplementation(async (_h, req) => { if (req.path.endsWith('capabilities')) { data.fill(0); return reply(caps); } expect(req.body?.subarray(0, png.length)).toEqual(png); return reply({ version: 1, attachmentId: 'id', mimeType: 'image/png', bytes: data.length }); });
    await expect(uploadRemoteChatImage(request, 'host', 'agent', data)).resolves.toMatchObject({ attachmentId: 'id' });
  });
  it.each([{}, { attachments: { ...caps.attachments, imageTypes: [] } }, { attachments: { ...caps.attachments, maxImageBytes: 1 } }])('refuses unsupported upload without posting', async (body) => {
    const request = vi.fn<ChatImageTransport>(async () => reply(body));
    await expect(uploadRemoteChatImage(request, 'host', 'agent', png)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([{ version: 1, attachmentId: '/private', mimeType: 'image/png', bytes: png.length }, { version: 1, attachmentId: 'id', mimeType: 'image/jpeg', bytes: png.length }, { version: 1, attachmentId: 'id', mimeType: 'image/png', bytes: 0 }])('refuses malformed upload receipt', async (body) => {
    await expect(uploadRemoteChatImage(transport(body), 'host', 'agent', png)).rejects.toThrow();
  });
});
