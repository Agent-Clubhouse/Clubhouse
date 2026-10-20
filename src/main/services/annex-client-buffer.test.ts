/**
 * Tests for the remote PTY buffer cache in annex-client.ts.
 *
 * The controller caches pty:data events locally using headless terminals
 * so that switching away from a remote agent tab and back restores the
 * terminal instantly without a network round-trip. The cache is seeded from
 * the satellite's /buffer on first access and stitched to the live stream by
 * seq (#2324).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing annex-client
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-annex'),
    getName: vi.fn().mockReturnValue('Clubhouse'),
    getVersion: vi.fn().mockReturnValue('0.0.0-test'),
    on: vi.fn(),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock('bonjour-service', () => ({
  default: class {
    find = vi.fn().mockReturnValue({ stop: vi.fn() });
    destroy = vi.fn();
  },
}));

vi.mock('ws', () => ({
  WebSocket: class {
    static OPEN = 1;
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    ping = vi.fn();
    terminate = vi.fn();
    readyState = 1;
  },
}));

vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: vi.fn().mockReturnValue({
    fingerprint: 'test-fp',
    publicKey: 'test-pk',
  }),
  getIdentity: vi.fn().mockReturnValue(null),
}));

vi.mock('./annex-tls', () => ({
  createTlsClientOptions: vi.fn().mockReturnValue({
    cert: 'test-cert',
    key: 'test-key',
    rejectUnauthorized: false,
  }),
  getOrCreateCert: vi.fn().mockReturnValue({
    certPem: 'test-cert',
    keyPem: 'test-key',
  }),
}));

vi.mock('./annex-peers', () => ({
  getPeer: vi.fn().mockReturnValue(null),
  addPeer: vi.fn(),
  removePeer: vi.fn(),
  removeAllPeers: vi.fn(),
  updateLastSeen: vi.fn(),
}));

vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({ autoReconnect: false }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return { ...actual, get: vi.fn() };
});

// A real headless xterm, with the constructor wrapped so tests can read the
// options each cache terminal was created with.
vi.mock('@xterm/headless', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xterm/headless')>();
  return {
    ...actual,
    Terminal: vi.fn(function (options: ConstructorParameters<typeof actual.Terminal>[0]) {
      return new actual.Terminal(options);
    }),
  };
});

import * as https from 'https';
import { Terminal } from '@xterm/headless';
import {
  cacheRemotePtyData,
  resizeRemoteBuffer,
  getLocalRemoteBuffer,
  requestPtyBuffer,
  requestPtyBufferSnapshot,
  stopClient,
  _addConnectedSatelliteForTesting,
  _receiveSatelliteMessageForTesting,
  _receiveSatelliteDisconnectForTesting,
} from './annex-client';
import * as headlessTerminal from './pty-headless-terminal';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { ANNEX_BUFFER_HEADERS } from '../../shared/annex-pty';

const SAT = 'sat-1';
// Seqs never go backwards across a client restart, so each test gets a fresh
// agent to start from seq 0.
let AGENT = 'agent-0';
let agentCounter = 0;

/**
 * Make the next satellite /buffer fetch wait until `respond` is called, so a
 * test can deliver live pty:data while it is in flight.
 */
function deferBufferFetch() {
  let reply: ((body: string, headers?: Record<string, string>) => void) | null = null;
  vi.mocked(https.get).mockImplementation(((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    reply = (body, headers = {}) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers, resume: vi.fn() });
      cb(res);
      res.emit('data', Buffer.from(body, 'utf-8'));
      res.emit('end');
    };
    return req;
  }) as unknown as typeof https.get);
  return {
    respond(body: string, headers?: Record<string, string>) {
      expect(reply).not.toBeNull();
      reply!(body, headers);
    },
  };
}

/** Deliver a pty:data event as if it arrived on the satellite's socket. */
function livePtyData(data: string, outputSeq?: number) {
  _receiveSatelliteMessageForTesting(SAT, {
    type: 'pty:data',
    payload: { agentId: AGENT, data, ...(outputSeq !== undefined && { outputSeq }) },
  });
}

/** The visible text of the cache's terminal, one string per non-empty line. */
async function cachedLines(): Promise<string[]> {
  const snap = await headlessTerminal.snapshot(`remote:${SAT}:${AGENT}`);
  const term = new (await vi.importActual<typeof import('@xterm/headless')>('@xterm/headless')).Terminal({
    cols: 80, rows: 10, allowProposedApi: true,
  });
  await new Promise<void>((resolve) => term.write(snap?.data ?? '', resolve));
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const text = term.buffer.active.getLine(i)?.translateToString(true) ?? '';
    if (text) lines.push(text);
  }
  term.dispose();
  return lines;
}

function forwardedPtyEvents(): Array<{ data: string; seq?: number }> {
  return vi.mocked(broadcastToAllWindows).mock.calls
    .map((call) => call[1] as { type?: string; payload?: { data: string; seq?: number } })
    .filter((evt) => evt?.type === 'pty:data')
    .map((evt) => evt.payload!);
}

describe('annex-client remote PTY buffer cache', () => {
  beforeEach(() => {
    vi.mocked(https.get).mockReset();
    vi.mocked(broadcastToAllWindows).mockClear();
    vi.mocked(Terminal).mockClear();
    headlessTerminal.disposeAll();
    // Reset client state
    stopClient();
    AGENT = `agent-${++agentCounter}`;
  });

  describe('cacheRemotePtyData', () => {
    it('feeds data into a headless terminal with namespaced key', async () => {
      cacheRemotePtyData(SAT, AGENT, 'hello world');
      expect(headlessTerminal.getSize(`remote:${SAT}:${AGENT}`)).toBeDefined();
      expect((await headlessTerminal.snapshot(`remote:${SAT}:${AGENT}`))?.data).toBe('hello world');
    });

    it('accumulates chunks in one terminal and returns a running seq', () => {
      expect(cacheRemotePtyData(SAT, AGENT, 'chunk1')).toEqual({ data: 'chunk1', seq: 6 });
      expect(cacheRemotePtyData(SAT, AGENT, 'chunk2')).toEqual({ data: 'chunk2', seq: 12 });
      expect(cacheRemotePtyData(SAT, AGENT, 'chunk3')).toEqual({ data: 'chunk3', seq: 18 });
      expect(Terminal).toHaveBeenCalledTimes(1);
    });

    it('isolates data between agents and satellites', () => {
      cacheRemotePtyData(SAT, `${AGENT}-A`, 'data-A');
      cacheRemotePtyData(SAT, `${AGENT}-B`, 'data-B');
      cacheRemotePtyData('sat-2', `${AGENT}-A`, 'data-sat2');
      expect(Terminal).toHaveBeenCalledTimes(3);
    });
  });

  describe('resizeRemoteBuffer', () => {
    it('resizes the headless terminal for a cached remote agent', () => {
      cacheRemotePtyData(SAT, AGENT, 'data');
      resizeRemoteBuffer(SAT, AGENT, 100, 40);
      expect(headlessTerminal.getSize(`remote:${SAT}:${AGENT}`)).toEqual({ cols: 100, rows: 40 });
    });

    it('does nothing for an agent with no cached data', () => {
      resizeRemoteBuffer('sat-1', 'unknown-agent', 100, 40);
      expect(headlessTerminal.getSize('remote:sat-1:unknown-agent')).toBeUndefined();
    });
  });

  describe('getLocalRemoteBuffer', () => {
    it('returns empty string when no data has been cached', () => {
      expect(getLocalRemoteBuffer('sat-1', 'no-data-agent')).toBe('');
    });
  });

  describe('requestPtyBuffer', () => {
    it('returns the local cache when the satellite is not connected', async () => {
      cacheRemotePtyData(SAT, AGENT, 'line 1\r\n');
      cacheRemotePtyData(SAT, AGENT, 'line 2');
      expect(await requestPtyBuffer(SAT, AGENT)).toBe('line 1\r\nline 2');
      expect(https.get).not.toHaveBeenCalled();
    });

    it('returns empty string when no data cached and satellite not connected', async () => {
      expect(await requestPtyBuffer('unknown-sat', AGENT)).toBe('');
    });

    it('includes output whose parse had not finished when it was requested', async () => {
      // xterm parses asynchronously; the snapshot must wait for it.
      cacheRemotePtyData(SAT, AGENT, 'x'.repeat(50_000));
      cacheRemotePtyData(SAT, AGENT, '\r\nlast line');
      const snap = await requestPtyBufferSnapshot(SAT, AGENT);
      expect(snap.data.endsWith('last line')).toBe(true);
      expect(snap.seq).toBe(50_000 + '\r\nlast line'.length);
    });
  });

  describe('seq on forwarded pty:data', () => {
    it('forwards each chunk with the controller seq, matching the snapshot seq', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('', { [ANNEX_BUFFER_HEADERS.seq]: '0' });
      await pending;

      livePtyData('ab', 2);
      livePtyData('cde', 5);
      expect(forwardedPtyEvents()).toEqual([
        expect.objectContaining({ data: 'ab', seq: 2 }),
        expect.objectContaining({ data: 'cde', seq: 5 }),
      ]);
      expect((await requestPtyBufferSnapshot(SAT, AGENT)).seq).toBe(5);
    });

    it('counts chunks from older satellites that send no outputSeq', () => {
      _addConnectedSatelliteForTesting(SAT);
      livePtyData('abc');
      expect(forwardedPtyEvents()).toEqual([expect.objectContaining({ data: 'abc', seq: 3 })]);
    });
  });

  describe('seeding from the satellite (#2324)', () => {
    it('does not double-feed a chunk that arrives during the fetch and is in the satellite buffer', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);

      // Satellite seq 0..10 is "history\r\n" + "B"; "C" comes after its snapshot.
      livePtyData('B', 10);
      fetch.respond('history\r\nB', { [ANNEX_BUFFER_HEADERS.seq]: '10' });
      const snap = await pending;
      livePtyData('C', 11);

      expect(snap.seq).toBe(1);
      expect(await cachedLines()).toEqual(['history', 'BC']);
    });

    it('keeps a chunk that arrives during the fetch but after the satellite snapshot', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);

      livePtyData('B', 10);
      livePtyData('C', 11);
      fetch.respond('history\r\nB', { [ANNEX_BUFFER_HEADERS.seq]: '10' });
      const snap = await pending;

      expect(snap.seq).toBe(2);
      expect(await cachedLines()).toEqual(['history', 'BC']);
    });

    it('trims a chunk that straddles the satellite snapshot', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);

      livePtyData('BC', 11);
      fetch.respond('history\r\nB', { [ANNEX_BUFFER_HEADERS.seq]: '10' });
      await pending;

      expect(await cachedLines()).toEqual(['history', 'BC']);
    });

    it('replaces live output cached before the first request, keeping the history', async () => {
      _addConnectedSatelliteForTesting(SAT);
      livePtyData('live', 12);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history\r\nlive', { [ANNEX_BUFFER_HEADERS.seq]: '12' });
      await pending;

      expect(await cachedLines()).toEqual(['history', 'live']);
      // Later requests come from the cache and still have the history.
      expect((await requestPtyBuffer(SAT, AGENT)).includes('history')).toBe(true);
      expect(https.get).toHaveBeenCalledTimes(1);
    });

    it('drops chunks received during the fetch from an older satellite that sends no seq', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      livePtyData('B');
      fetch.respond('history\r\nB');
      await pending;

      expect(await cachedLines()).toEqual(['history', 'B']);
    });

    it('shares one satellite fetch between concurrent requests', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const first = requestPtyBufferSnapshot(SAT, AGENT);
      const second = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history', { [ANNEX_BUFFER_HEADERS.seq]: '7' });

      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(https.get).toHaveBeenCalledTimes(1);
    });

    it('seeds again after the Annex server disposed every headless terminal', async () => {
      _addConnectedSatelliteForTesting(SAT);
      let fetch = deferBufferFetch();
      let pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history', { [ANNEX_BUFFER_HEADERS.seq]: '7' });
      await pending;

      headlessTerminal.disposeAll();
      // Live output recreates an empty cache before the next request.
      livePtyData('\r\nmore', 13);
      fetch = deferBufferFetch();
      pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history\r\nmore', { [ANNEX_BUFFER_HEADERS.seq]: '13' });
      await pending;
      expect(https.get).toHaveBeenCalledTimes(2);
      expect(await cachedLines()).toEqual(['history', 'more']);
    });

    it('drops a chunk the buffer already had that arrives on the socket after the seed', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      // The HTTPS response overtakes the WebSocket frame for "B".
      fetch.respond('history\r\nB', { [ANNEX_BUFFER_HEADERS.seq]: '10' });
      const snap = await pending;
      vi.mocked(broadcastToAllWindows).mockClear();

      livePtyData('B', 10);
      livePtyData('CD', 12);

      expect(forwardedPtyEvents()).toEqual([expect.objectContaining({ data: 'CD', seq: snap.seq + 2 })]);
      expect(await cachedLines()).toEqual(['history', 'BCD']);
    });

    it('settles when the connection drops mid-body, so later requests are not stuck', async () => {
      _addConnectedSatelliteForTesting(SAT);
      vi.mocked(https.get).mockImplementationOnce(((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume: vi.fn() });
        cb(res);
        res.emit('data', Buffer.from('partial'));
        res.emit('close');
        return Object.assign(new EventEmitter(), { destroy: vi.fn() });
      }) as unknown as typeof https.get);

      expect(await requestPtyBufferSnapshot(SAT, AGENT)).toEqual({ data: '', seq: 0 });
    });

    it('does not mark a seed that straddled a disconnect as seeded', async () => {
      _addConnectedSatelliteForTesting(SAT);
      let fetch = deferBufferFetch();
      let pending = requestPtyBufferSnapshot(SAT, AGENT);
      _receiveSatelliteDisconnectForTesting(SAT);
      fetch.respond('stale', { [ANNEX_BUFFER_HEADERS.seq]: '5' });
      await pending;
      _addConnectedSatelliteForTesting(SAT);

      fetch = deferBufferFetch();
      pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('fresh', { [ANNEX_BUFFER_HEADERS.seq]: '5' });
      expect((await pending).data).toBe('fresh');
      expect(https.get).toHaveBeenCalledTimes(2);
    });

    it('stops trimming after a disconnect, since a restarted satellite counts from zero', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history', { [ANNEX_BUFFER_HEADERS.seq]: '500' });
      await pending;
      _receiveSatelliteDisconnectForTesting(SAT);
      vi.mocked(broadcastToAllWindows).mockClear();

      livePtyData('after restart', 13);
      expect(forwardedPtyEvents()).toEqual([expect.objectContaining({ data: 'after restart' })]);
    });
  });

  describe('mirror size and windowsPty', () => {
    it('creates the seeded cache at the satellite PTY size (#2325)', async () => {
      _addConnectedSatelliteForTesting(SAT);
      const fetch = deferBufferFetch();
      const pending = requestPtyBufferSnapshot(SAT, AGENT);
      fetch.respond('history', {
        [ANNEX_BUFFER_HEADERS.seq]: '7',
        [ANNEX_BUFFER_HEADERS.cols]: '80',
        [ANNEX_BUFFER_HEADERS.rows]: '24',
      });
      await pending;
      expect(headlessTerminal.getSize(`remote:${SAT}:${AGENT}`)).toEqual({ cols: 80, rows: 24 });
    });

    it("gives the cache a Windows satellite's windowsPty (#2352)", async () => {
      _addConnectedSatelliteForTesting(SAT, {
        projects: [], agents: {}, quickAgents: {}, theme: null, orchestrators: null,
        pendingPermissions: [], lastSeq: 0,
        ptyHost: { platform: 'win32', ptyBackend: 'conpty', windowsBuild: 22631 },
      });
      livePtyData('x', 1);
      expect(vi.mocked(Terminal).mock.calls[0][0]).toMatchObject({
        windowsPty: { backend: 'conpty', buildNumber: 22631 },
      });
    });

    it('gives no windowsPty for a satellite without ptyHost', () => {
      _addConnectedSatelliteForTesting(SAT);
      livePtyData('x', 1);
      expect(vi.mocked(Terminal).mock.calls[0][0]).not.toHaveProperty('windowsPty');
    });
  });
});
