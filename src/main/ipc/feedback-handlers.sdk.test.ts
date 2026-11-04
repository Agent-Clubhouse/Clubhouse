/**
 * A Send through the real IPC handler and FeedbackService, on the real vendored SDK. Only
 * Electron, safeStorage and the network are fakes; global fetch refuses, so nothing here can
 * reach a server.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  service: null as unknown,
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { fakes.handlers.set(channel, handler); }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }), getFocusedWindow: () => null },
}));
vi.mock('./window-handlers', () => ({ findMainWindow: () => undefined, listPopoutWindows: () => [] }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/framebriar', () => ({ isFeedbackEnabled: () => true, getFeedbackService: () => fakes.service }));

import { IPC } from '../../shared/ipc-channels';
import { createFramebriar, type Framebriar } from '../vendor/framebriar/adapters/node/index.mjs';
import { asyncOnlySafeStorage, fakeKeychain } from '../telemetry/__test-utils__/fake-safe-storage';
import { FeedbackService } from '../services/framebriar/feedback-service';
import { registerFeedbackHandlers } from './feedback-handlers';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const HOUR = 3_600_000;
const INVITE = 'a'.repeat(43);
const CAPTURE = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('the original capture')]);
const OVER_CAP = 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4);

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

let dataDir: string;
let service: FeedbackService;
let sdk: Framebriar & { outbox: Framebriar['outbox'] & { dir: string; list(): Promise<Array<{ id: string }>> } };
/** Set to make the next save fail with nothing saved, so the draft stays. */
let saveFails = false;

const send = (input: Record<string, unknown>) => Promise.resolve().then(() => fakes.handlers.get(IPC.FEEDBACK.SEND)!({ sender: {} }, input));

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'clubhouse-feedback-ipc-'));
  saveFails = false;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('This test must not reach the network'); }));
  const grant = { v: 1, gameId: 'clubhouse', scopeVersion: 2, token: 't'.repeat(43), refreshToken: 'r'.repeat(43), expiresAt: new Date(NOW + HOUR).toISOString(), refreshExpiresAt: new Date(NOW + 720 * HOUR).toISOString() };
  service = new FeedbackService({
    safeStorage: asyncOnlySafeStorage(fakeKeychain()), dataDir, appVersion: '0.42.0', isOnline: () => false, now: () => NOW,
    captureCorrelation: () => ({ data: {} }) as never,
    create: ((opts: Parameters<typeof createFramebriar>[0]) => {
      const real = createFramebriar({ ...opts, endpoint: 'https://framebriar.test/api', now: () => NOW, fetchImpl: (async () => json(grant)) as never });
      sdk = { ...real, feedback: { ...real.feedback, submit: async (value, options) => {
        if (saveFails) { saveFails = false; throw Object.assign(new Error('Local feedback storage is full'), { code: 'storage-full' }); }
        return real.feedback.submit(value, options);
      } } } as typeof sdk;
      return sdk;
    }) as never,
  });
  fakes.service = service;
  fakes.handlers.clear();
  registerFeedbackHandlers();
  await service.connect(INVITE);
});

afterEach(async () => {
  await service.shutdown();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe.each([
  ['over the cap', { annotatedPng: OVER_CAP }],
  ['not base64', { annotatedPng: 'not base64!' }],
  ['over the cap, with the flag', { annotatedPng: OVER_CAP, noEdits: true }],
  ['not base64, with the flag', { annotatedPng: 'not base64!', noEdits: true }],
])('flattened bytes %s on a Send that leaves the image out', (_name, bad) => {
  it('the note saves, with no media', async () => {
    const { draftId } = await service.captureDraft(async () => CAPTURE);
    await expect(send({ draftId, notes: 'it broke', includeScreenshot: false, shotId: 's0', ...bad })).resolves.toMatchObject({ status: 'saved-local' });
    const [item, ...others] = await sdk.outbox.list();
    expect(others).toEqual([]);
    const { report } = JSON.parse(readFileSync(join(sdk.outbox.dir, 'reports', item.id, 'report.json'), 'utf-8'));
    expect(report).toMatchObject({ media: null, notes: 'it broke' });
  });

  it('the capture is gone: a later Send with the image and no bytes, or its own bytes, fails', async () => {
    const { draftId } = await service.captureDraft(async () => CAPTURE);
    saveFails = true;
    await expect(send({ draftId, notes: 'it broke', includeScreenshot: false, shotId: 's0', ...bad })).rejects.toMatchObject({ code: 'storage-full' });
    await expect(send({ draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).rejects.toMatchObject({ code: 'flattened-required' });
    await expect(send({ draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0', annotatedPng: CAPTURE.toString('base64') })).rejects.toMatchObject({ code: 'flattened-required' });
    expect(await sdk.outbox.list()).toEqual([]);
  });
});

it('without those bytes, the flag with a window keeps the capture, so the test above is about them', async () => {
  const { draftId } = await service.captureDraft(async () => CAPTURE);
  saveFails = true;
  await expect(send({ draftId, notes: 'it broke', includeScreenshot: false, shotId: 's0', noEdits: true })).rejects.toMatchObject({ code: 'storage-full' });
  await expect(send({ draftId, notes: 'it broke', includeScreenshot: true, shotId: 's0' })).resolves.toMatchObject({ status: 'saved-local' });
});
