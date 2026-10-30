import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import type { ChatEventDraft, ChatImage, ChatMediaAssetResult } from '../../../shared/chat';
import { appLog } from '../log-service';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-media-'));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpRoot, 'userData') } }));
vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

import {
  ChatMediaPolicy, RAW_IMAGE_PLACEHOLDER, decodeBase64Image, fetchRemoteImage, isPrivateHost,
  readMedia, resolveLocalPath, scrubRawOutput, storeMedia,
} from './chat-media';
import { agentMediaDir } from './chat-transcript';

const AGENT = 'agent-1';

function png(w = 2, h = 3, padding = 0): Uint8Array {
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(w), ...be(h), 8, 6, 0, 0, 0, ...new Array(padding).fill(7)]);
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const project = path.join(tmpRoot, 'project');
const outside = path.join(tmpRoot, 'outside');

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'userData'), { recursive: true, force: true });
  // The transcript makes the agent's folder; media is only written once it exists.
  fs.mkdirSync(path.dirname(agentMediaDir(AGENT)), { recursive: true });
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'shots'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function policy(enabled: boolean): ChatMediaPolicy {
  return new ChatMediaPolicy({ agentId: AGENT, enabled: () => enabled, cwd: () => project });
}

function update(media: ChatImage[], extra: Record<string, unknown> = {}): ChatEventDraft {
  return { type: 'tool_call_update', data: { toolCallId: 't1', status: 'completed', media, ...extra } };
}

describe('decodeBase64Image', () => {
  it('takes plain base64 and base64 data: URLs only', () => {
    expect(decodeBase64Image(b64(png()))).toEqual(png());
    expect(decodeBase64Image(`data:image/png;base64,${b64(png())}`)).toEqual(png());
    expect(decodeBase64Image('data:image/svg+xml,<svg/>')).toBeUndefined();
    expect(decodeBase64Image('not base64!')).toBeUndefined();
    expect(decodeBase64Image('')).toBeUndefined();
  });
});

describe('resolveLocalPath', () => {
  it('resolves absolute paths anywhere, and relative ones against the base (#2478)', async () => {
    fs.writeFileSync(path.join(project, 'shots', 'a.png'), png());
    fs.writeFileSync(path.join(outside, 'secret.png'), png());
    // Native realpath, as the code uses: it expands Windows 8.3 names (RUNNER~1) the JS one keeps.
    const real = fs.realpathSync.native(path.join(project, 'shots', 'a.png'));
    expect(await resolveLocalPath(path.join(project, 'shots', 'a.png'))).toBe(real);
    expect(await resolveLocalPath('shots/a.png', project)).toBe(real);
    expect(await resolveLocalPath(path.join(outside, 'secret.png'), project)).toBe(fs.realpathSync.native(path.join(outside, 'secret.png')));
    expect(await resolveLocalPath('../outside/secret.png', project)).toBe(fs.realpathSync.native(path.join(outside, 'secret.png')));
  });

  it('resolves nothing for missing files, NUL bytes, or a relative path with no base', async () => {
    expect(await resolveLocalPath(path.join(project, 'nope.png'))).toBeUndefined();
    expect(await resolveLocalPath(`${project}\0/x`)).toBeUndefined();
    expect(await resolveLocalPath('shots', undefined)).toBeUndefined();
    expect(await resolveLocalPath('shots', 'relative/base')).toBeUndefined();
    expect(await resolveLocalPath('')).toBeUndefined();
  });

  // Windows CI can't create symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')('resolves symlinks to the real file', async () => {
    fs.writeFileSync(path.join(outside, 'secret.png'), png());
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(project, 'link.png'));
    fs.symlinkSync(outside, path.join(project, 'linkdir'), 'dir');
    const real = fs.realpathSync.native(path.join(outside, 'secret.png'));
    expect(await resolveLocalPath(path.join(project, 'link.png'))).toBe(real);
    expect(await resolveLocalPath(path.join('linkdir', 'secret.png'), project)).toBe(real);
  });

  it('never touches network or device paths', async () => {
    const realpath = vi.mocked(fsp.realpath);
    realpath.mockClear();
    for (const p of ['\\\\attacker.example\\x\\a.png', '//attacker.example/x/a.png', '\\\\?\\C:\\a.png', '\\\\.\\pipe\\x']) {
      expect(await resolveLocalPath(p, project)).toBeUndefined();
    }
    // A relative path can't climb into one either.
    expect(await resolveLocalPath('x/a.png', '//attacker.example/share')).toBeUndefined();
    if (process.platform === 'darwin') expect(await resolveLocalPath('/net/attacker.example/x/a.png')).toBeUndefined();
    expect(realpath).not.toHaveBeenCalled();
  });
});

describe('storeMedia / readMedia', () => {
  it('stores by content hash once, with header dimensions', async () => {
    const bytes = png(640, 480);
    const first = await storeMedia(AGENT, bytes);
    const again = await storeMedia(AGENT, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(first).toEqual({ type: 'image', mimeType: 'image/png', mediaRef: `${hash}.png`, width: 640, height: 480 });
    expect(again).toEqual(first);
    expect(fs.readdirSync(agentMediaDir(AGENT))).toEqual([`${hash}.png`]);
    expect(await readMedia(AGENT, `${hash}.png`)).toEqual({ mimeType: 'image/png', data: bytes });
  });

  it('refuses an image whose header declares a huge canvas', async () => {
    expect(await storeMedia(AGENT, png(20000, 20000))).toBeUndefined();
  });

  it('refuses bytes that are not a supported image', async () => {
    expect(await storeMedia(AGENT, new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(await storeMedia(AGENT, new Uint8Array())).toBeUndefined();
  });

  it("writes nothing when the agent's transcript folder doesn't exist", async () => {
    expect(await storeMedia('no-transcript-yet', png())).toBeUndefined();
    expect(fs.existsSync(agentMediaDir('no-transcript-yet'))).toBe(false);
  });

  it('reads only valid references', async () => {
    await expect(readMedia(AGENT, '../../secrets.json')).rejects.toThrow('Not a media reference');
    await expect(readMedia(AGENT, `${'a'.repeat(64)}.png`)).rejects.toThrow();
  });
});

describe('scrubRawOutput', () => {
  it('cuts base64 image payloads and keeps everything else', () => {
    const big = b64(png(2, 2, 400));
    const raw = {
      type: 'image',
      file: { base64: big, type: 'image/png', originalSize: 10 },
      content: [{ type: 'image', data: big, mimeType: 'image/png' }, { type: 'text', text: 'ok' }],
      source: { type: 'base64', media_type: 'image/png', data: big },
      url: `data:image/png;base64,${big}`,
      resource: { uri: 'x', mimeType: 'image/png', blob: big },
      note: 'kept',
      data: 'short',
    };
    expect(scrubRawOutput(raw)).toEqual({
      type: 'image',
      file: { base64: RAW_IMAGE_PLACEHOLDER, type: 'image/png', originalSize: 10 },
      content: [{ type: 'image', data: RAW_IMAGE_PLACEHOLDER, mimeType: 'image/png' }, { type: 'text', text: 'ok' }],
      source: { type: 'base64', media_type: 'image/png', data: RAW_IMAGE_PLACEHOLDER },
      url: RAW_IMAGE_PLACEHOLDER,
      resource: { uri: 'x', mimeType: 'image/png', blob: RAW_IMAGE_PLACEHOLDER },
      note: 'kept',
      data: 'short',
    });
  });

  it('returns the same object when there is nothing to cut', () => {
    const raw = { stdout: 'x'.repeat(1000), nested: [{ data: 'y'.repeat(500) }] };
    expect(scrubRawOutput(raw)).toBe(raw);
  });
});

describe('ChatMediaPolicy', () => {
  it('with the flag off, leaves events exactly as they were before rich content', async () => {
    const p = policy(false);
    const draft = update([{ type: 'image', mimeType: 'image/png', data: b64(png()) }], { content: [{ type: 'text', text: 'read' }], rawOutput: { base64: 'x'.repeat(300) } });
    expect(await p.apply(draft)).toEqual({ type: 'tool_call_update', data: { toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: 'read' }], rawOutput: { base64: 'x'.repeat(300) } } });
    const plain: ChatEventDraft = { type: 'agent_message', data: { messageId: 'm', text: 'hi' } };
    expect(await p.apply(plain)).toBe(plain);
    expect(fs.existsSync(agentMediaDir(AGENT))).toBe(false);
  });

  it('with the flag off, drops media-only calls and their updates', async () => {
    const p = policy(false);
    expect(await p.apply({ type: 'tool_call', data: { toolCallId: 'g1', kind: 'other', title: 'Generating image', status: 'in_progress', toolName: 'imageGeneration', mediaOnly: true } })).toBeNull();
    expect(await p.apply({ type: 'tool_call_update', data: { toolCallId: 'g1', status: 'completed', media: [{ type: 'image', mimeType: 'image/png', data: b64(png()) }] } })).toBeNull();
    const other: ChatEventDraft = { type: 'tool_call_update', data: { toolCallId: 'other', status: 'completed' } };
    expect(await p.apply(other)).toBe(other);
    // A real tool that happens to be called "image" isn't media-only.
    const real: ChatEventDraft = { type: 'tool_call', data: { toolCallId: 'r', kind: 'other', title: 'image', status: 'pending', toolName: 'image' } };
    expect(await p.apply(real)).toBe(real);
  });

  it('stores image bytes and keeps only the reference, so the transcript stays small', async () => {
    const big = png(1000, 800, 2 * 1024 * 1024);
    const out = await policy(true).apply(update([{ type: 'image', mimeType: 'image/png', data: b64(big) }], { rawOutput: { type: 'image', file: { base64: b64(big) } } }));
    const data = out!.data as { media: ChatImage[]; rawOutput: unknown };
    expect(data.media).toEqual([{ type: 'image', mimeType: 'image/png', mediaRef: expect.stringMatching(/^[0-9a-f]{64}\.png$/), width: 1000, height: 800 }]);
    expect(data.rawOutput).toEqual({ type: 'image', file: { base64: RAW_IMAGE_PLACEHOLDER } });
    expect(JSON.stringify(out).length).toBeLessThan(1024);
  });

  it('stores SVG as an image file by reference', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const out = await policy(true).apply(update([{ type: 'image', mimeType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') }]));
    expect((out!.data as { media: ChatImage[] }).media).toEqual([{ type: 'image', mimeType: 'image/svg+xml', mediaRef: expect.stringMatching(/\.svg$/) }]);
  });

  it('trusts the bytes, not the declared type, and drops what is not an image', async () => {
    const out = await policy(true).apply(update([
      { type: 'image', mimeType: 'image/png', data: Buffer.from('<html>').toString('base64') },
      { type: 'image', mimeType: 'image/gif', data: b64(png()) },
    ]));
    expect((out!.data as { media: ChatImage[] }).media).toEqual([expect.objectContaining({ mimeType: 'image/png' })]);
  });

  it('reads a source path anywhere, relative ones against the cwd, and skips missing or non-image files (#2478)', async () => {
    fs.writeFileSync(path.join(project, 'shots', 'in.png'), png(4, 4));
    fs.writeFileSync(path.join(outside, 'out.png'), png(5, 5));
    fs.writeFileSync(path.join(outside, 'notes.txt'), 'text');
    const out = await policy(true).apply(update([
      { type: 'image', mimeType: 'image/*', sourcePath: path.join('shots', 'in.png') },
      { type: 'image', mimeType: 'image/*', sourcePath: path.join(outside, 'out.png') },
      { type: 'image', mimeType: 'image/*', sourcePath: path.join(outside, 'nope.png') },
      { type: 'image', mimeType: 'image/*', sourcePath: path.join(outside, 'notes.txt') },
    ]));
    expect((out!.data as { media: ChatImage[] }).media).toEqual([
      expect.objectContaining({ width: 4, height: 4, sourcePath: path.join('shots', 'in.png') }),
      expect.objectContaining({ width: 5, height: 5, sourcePath: path.join(outside, 'out.png') }),
    ]);
  });

  it('keeps remote images as links without fetching them, and drops other schemes', async () => {
    const out = await policy(true).apply(update([
      { type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' },
      { type: 'image', mimeType: 'image/png', uri: 'file:///etc/passwd' },
      { type: 'image', mimeType: 'image/png', uri: 'javascript:alert(1)' },
    ]));
    expect((out!.data as { media: ChatImage[] }).media).toEqual([{ type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' }]);
  });

  it('keeps a media-only call that starts without its image, and says so if the image is lost', async () => {
    const p = policy(true);
    const started: ChatEventDraft = { type: 'tool_call', data: { toolCallId: 'g1', kind: 'other', title: 'Generating image', status: 'in_progress', toolName: 'imageGeneration', mediaOnly: true } };
    expect(await p.apply(started)).toEqual(started);
    expect(await p.apply({ type: 'tool_call_update', data: { toolCallId: 'g1', status: 'completed', media: [{ type: 'image', mimeType: 'image/png', data: 'bm9wZQ==' }] } }))
      .toEqual({ type: 'tool_call_update', data: { toolCallId: 'g1', status: 'completed', error: 'The image could not be shown' } });
  });

  it('drops a media-only call whose image could not be stored', async () => {
    const out = await policy(true).apply({ type: 'tool_call', data: { toolCallId: 'i1', kind: 'other', title: 'Image', status: 'completed', toolName: 'image', mediaOnly: true, media: [{ type: 'image', mimeType: 'image/png', data: 'bm9wZQ==' }] } });
    expect(out).toBeNull();
  });
});

describe('ChatMediaPolicy: user images (#2453)', () => {
  const sent = (source: 'user' | 'annex' | 'mcp', file: string): ChatEventDraft => ({ type: 'user_message', data: {
    messageId: 'm1', source, delivery: 'prompt',
    content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', path: file }, { type: 'file', path: '/tmp/notes.txt' }],
  } });

  it('stores a sent image and adds its mediaRef, flag on or off, keeping the desktop path in the transcript', async () => {
    fs.mkdirSync(outside, { recursive: true });
    const file = path.join(outside, 'phone.png');
    const bytes = png(4, 5);
    fs.writeFileSync(file, bytes);
    const ref = `${createHash('sha256').update(bytes).digest('hex')}.png`;
    for (const enabled of [false, true]) {
      const out = await policy(enabled).apply(sent('annex', file));
      expect(out).toEqual({ type: 'user_message', data: { messageId: 'm1', source: 'annex', delivery: 'prompt', content: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', path: file, mediaRef: ref, width: 4, height: 5 },
        { type: 'file', path: '/tmp/notes.txt' },
      ] } });
    }
    expect(fs.readFileSync(path.join(agentMediaDir(AGENT), ref))).toEqual(Buffer.from(bytes));
  });

  it('leaves other sources, and an image it cannot read, as they were', async () => {
    fs.mkdirSync(outside, { recursive: true });
    const file = path.join(outside, 'agent.png');
    fs.writeFileSync(file, png());
    const mcp = sent('mcp', file);
    expect(await policy(true).apply(mcp)).toBe(mcp);
    const missing = sent('user', path.join(outside, 'gone.png'));
    expect(await policy(true).apply(missing)).toEqual(missing);
    expect(fs.existsSync(agentMediaDir(AGENT))).toBe(false);
  });
});

describe('ChatMediaPolicy: Copilot binary asset results (#2421)', () => {
  const assetId = `sha256:${'cd'.repeat(32)}`;
  // The persisted payload shape from the issue, as the ACP mapper passes it on.
  const rawOutput = {
    content: 'Viewed image file successfully.',
    binaryResultsForLlm: [{ type: 'image', assetId, mimeType: 'image/png', byteLength: 212249 }],
  };
  const withResolver = (resolveAsset: (id: string) => Promise<ChatMediaAssetResult | undefined>, enabled = true) =>
    new ChatMediaPolicy({ agentId: AGENT, enabled: () => enabled, cwd: () => project, resolveAsset });

  beforeEach(() => vi.mocked(appLog).mockClear());

  it('stores the resolved bytes and keeps the tool output as it was', async () => {
    const bytes = png(6, 7);
    const resolveAsset = vi.fn(async () => ({ ok: true as const, bytes }));
    const draft = update([{ type: 'image', mimeType: 'image/png', assetId }], { content: [{ type: 'content', content: { type: 'text', text: 'Viewed image file successfully.' } }], rawOutput });
    const out = await withResolver(resolveAsset).apply(draft);
    expect(resolveAsset).toHaveBeenCalledWith(assetId);
    const data = out!.data as { media: ChatImage[]; rawOutput: unknown; content: unknown };
    const ref = `${createHash('sha256').update(bytes).digest('hex')}.png`;
    expect(data.media).toEqual([{ type: 'image', mimeType: 'image/png', mediaRef: ref, width: 6, height: 7, assetId }]);
    expect(data.rawOutput).toEqual(rawOutput);
    expect(data.content).toEqual((draft.data as { content: unknown }).content);
    expect(fs.readFileSync(path.join(agentMediaDir(AGENT), ref))).toEqual(Buffer.from(bytes));
    // No bytes in the event itself.
    expect(JSON.stringify(out)).not.toContain(Buffer.from(bytes).toString('base64'));
  });

  it('marks an asset it cannot resolve as unavailable and logs why', async () => {
    const out = await withResolver(async () => ({ ok: false, reason: 'not_found' })).apply(update([{ type: 'image', mimeType: 'image/png', assetId }], { rawOutput }));
    expect((out!.data as { media: ChatImage[] }).media).toEqual([{ type: 'image', mimeType: 'image/png', assetId, unavailable: true }]);
    expect(appLog).toHaveBeenCalledWith('core:chat', 'warn', 'Chat image asset not available', { meta: { agentId: AGENT, assetId, reason: 'not_found' } });
  });

  it('marks resolved bytes that are not an image, a resolver that throws, and a driver without one as unavailable', async () => {
    const cases: Array<[ChatMediaPolicy, string]> = [
      [withResolver(async () => ({ ok: true, bytes: new Uint8Array(Buffer.from('<html>')) })), 'not_an_image'],
      [withResolver(async () => { throw new Error('boom'); }), 'read_failed: boom'],
      [withResolver(async () => undefined), 'unsupported'],
      [policy(true), 'unsupported'],
    ];
    for (const [p, reason] of cases) {
      const out = await p.apply(update([{ type: 'image', mimeType: 'image/png', assetId }]));
      expect((out!.data as { media: ChatImage[] }).media).toEqual([{ type: 'image', mimeType: 'image/png', assetId, unavailable: true }]);
      expect(appLog).toHaveBeenLastCalledWith('core:chat', 'warn', 'Chat image asset not available', { meta: { agentId: AGENT, assetId, reason } });
    }
  });

  it('never asks the resolver for an id that is not sha256, and keeps an omitted image as unavailable', async () => {
    const resolveAsset = vi.fn(async () => ({ ok: true as const, bytes: png() }));
    const out = await withResolver(resolveAsset).apply(update([
      { type: 'image', mimeType: 'image/png', assetId: '../../etc/passwd' },
      { type: 'image', mimeType: 'image/png', unavailable: true },
    ]));
    expect(resolveAsset).not.toHaveBeenCalled();
    expect((out!.data as { media: ChatImage[] }).media).toEqual([
      { type: 'image', mimeType: 'image/png', unavailable: true },
      { type: 'image', mimeType: 'image/png', unavailable: true },
    ]);
  });

  it('with the flag off, resolves nothing and leaves the event as before', async () => {
    const resolveAsset = vi.fn(async () => ({ ok: true as const, bytes: png() }));
    const out = await withResolver(resolveAsset, false).apply(update([{ type: 'image', mimeType: 'image/png', assetId }], { rawOutput }));
    expect(resolveAsset).not.toHaveBeenCalled();
    expect(out).toEqual({ type: 'tool_call_update', data: { toolCallId: 't1', status: 'completed', rawOutput } });
    expect(fs.existsSync(agentMediaDir(AGENT))).toBe(false);
  });
});

describe('fetchRemoteImage', () => {
  /** Public DNS answer for any name, so tests never touch the network. */
  const publicDns = async () => ['93.184.216.34'];
  const ok = (body: Uint8Array, headers: Record<string, string> = {}) => new Response(body as BodyInit, { status: 200, headers });

  it('loads a web image and sniffs it', async () => {
    const fetcher = vi.fn(async () => ok(png()));
    expect(await fetchRemoteImage('https://example.com/a.png', fetcher, publicDns)).toEqual({ mimeType: 'image/png', data: png() });
    expect(fetcher).toHaveBeenCalledWith('https://example.com/a.png', expect.objectContaining({ credentials: 'omit', redirect: 'manual' }));
  });

  it('refuses private hosts, other schemes and credentials before fetching', async () => {
    const fetcher = vi.fn(async () => ok(png()));
    for (const url of ['http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://192.168.1.2/a.png', 'http://[::1]/a.png', 'http://169.254.169.254/x', 'file:///etc/hosts', 'https://u:p@example.com/a.png', 'http://intranet/a.png']) {
      await expect(fetchRemoteImage(url, fetcher, publicDns)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks each redirect hop', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/a.png' } }));
    await expect(fetchRemoteImage('https://example.com/a.png', fetcher, publicDns)).rejects.toThrow('not loaded');
  });

  it('refuses non-images and oversized bodies', async () => {
    await expect(fetchRemoteImage('https://example.com/a', async () => ok(new TextEncoder().encode('<html>'), { 'content-type': 'image/png' }), publicDns)).rejects.toThrow('not a supported image');
    await expect(fetchRemoteImage('https://example.com/a', async () => ok(png(), { 'content-length': String(64 * 1024 * 1024) }), publicDns)).rejects.toThrow('too large');
  });

  it('refuses a public name that resolves to a private address', async () => {
    const fetcher = vi.fn(async () => ok(png()));
    await expect(fetchRemoteImage('https://127.0.0.1.nip.io/a.png', fetcher, async () => ['127.0.0.1'])).rejects.toThrow('not loaded');
    await expect(fetchRemoteImage('https://unknown.example/a.png', fetcher, async () => [])).rejects.toThrow('could not be loaded');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('knows private hosts', () => {
    expect(isPrivateHost('localhost.')).toBe(true);
    expect(isPrivateHost('router.local.')).toBe(true);
    expect(isPrivateHost('[::7f00:1]')).toBe(true);
    expect(isPrivateHost('[::127.0.0.1]')).toBe(true);
    expect(isPrivateHost('[64:ff9b::7f00:1]')).toBe(true);
    expect(isPrivateHost('[2606:4700::1]')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.20.0.1')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
    expect(isPrivateHost('[fd00::1]')).toBe(true);
  });
});
