import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveStructuredSpawn } from '../structured-spawn';
import { EventLog, NdjsonPeer, chatFixturePath, writeFakeCliShims } from './fake-cli';

describe('writeFakeCliShims', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('a shim named like the real CLI completes the codex handshake through the production spawn path', async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fake-cli-shims-'));
    const report = path.join(dir, 'report.json');
    const shims = await writeFakeCliShims(path.join(dir, 'bin'), {
      codex: { fixture: chatFixturePath('codex', 'multi-turn'), report },
    });
    expect(path.basename(shims.codex)).toBe(process.platform === 'win32' ? 'codex.cmd' : 'codex');

    // On Windows this routes through cmd.exe, like an npm-installed codex.cmd.
    const command = resolveStructuredSpawn(shims.codex, ['app-server']);
    const codexHome = path.join(dir, 'codex-home');
    const peer = NdjsonPeer.start(command.binary, command.args, {
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      env: { ...process.env, CODEX_HOME: codexHome, COPILOT_HOME: undefined },
    });
    peer.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clubhouse', title: 'Clubhouse', version: '1.0.0' }, capabilities: {} } });
    const init = await peer.waitFor({ id: 1 });
    expect(init).toMatchObject({ result: { userAgent: expect.stringContaining('0.159.3') } });

    peer.closeStdin();
    expect((await peer.exited).code).toBe(0);
    const written = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(written.argv).toEqual(['app-server']);
    expect(written.stdinClosed).toBe(true);
    // The state-dir variables it was launched with, so E2E can check the app passed them on.
    expect(written.env).toMatchObject({ CODEX_HOME: codexHome, COPILOT_HOME: null });
  });
});

describe('EventLog', () => {
  it('walks forward through repeated matches and times out cleanly', async () => {
    const log = new EventLog<{ type: string; n: number }>();
    log.push({ type: 'done', n: 1 });
    setTimeout(() => log.push({ type: 'done', n: 2 }), 5);
    expect((await log.waitFor({ type: 'done' })).n).toBe(1);
    expect((await log.waitFor({ type: 'done' })).n).toBe(2);
    await expect(log.waitFor({ type: 'done' }, 20)).rejects.toThrow('timed out');
  });

  it('collects an async event stream, the way a driver session emits drafts', async () => {
    async function* drafts() {
      yield { type: 'turn_started', data: {} };
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { type: 'protocol_unknown', data: { name: 'item/hologram/delta' } };
      yield { type: 'turn_ended', data: { reason: 'completed' } };
    }
    const log = EventLog.fromAsyncIterable(drafts());
    expect(await log.waitFor({ type: 'protocol_unknown' })).toMatchObject({ data: { name: 'item/hologram/delta' } });
    await log.waitFor({ type: 'turn_ended' });
    expect(log.types()).toEqual(['turn_started', 'protocol_unknown', 'turn_ended']);
    // Once the stream ends, a wait for something that never came fails fast.
    await expect(log.waitFor({ type: 'error' }, 2000)).rejects.toThrow('stream ended without');
  });
});
