import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeCopilotEnv } from './test-env';
import { CopilotSdkChatDriver, copilotPlanAction, parseSlashCommand, toSdkMcpServers } from './driver';

let originalEnv: NodeJS.ProcessEnv;
let home: string;
beforeEach(() => {
  originalEnv = process.env;
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-fake-home-'));
  process.env = fakeCopilotEnv(originalEnv, home);
});
afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A `copilot` that runs `script` under Node, on any platform. */
function fakeCli(dir: string, script: string): string {
  const js = path.join(dir, 'fake.js');
  fs.writeFileSync(js, script);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'copilot.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, 'copilot');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return bin;
}

describe('CopilotSdkChatDriver handshake failures, which open the CLI view', () => {
  const driver = new CopilotSdkChatDriver({ probeTimeoutMs: 3_000 });
  const dirs: string[] = [];
  const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-fake-')); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('reports a CLI that exits at launch', async () => {
    const probe = await driver.probe(fakeCli(dir(), 'console.error("unknown option --headless"); process.exit(1);'));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'process_exited' });
    expect(probe.error).toContain('unknown option');
  }, 30_000);

  it('times out on a CLI that never listens, and leaves nothing running', async () => {
    const pidFile = path.join(dir(), 'pid');
    const probe = await driver.probe(fakeCli(dir(), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(false);
  }, 30_000);

  // Answers every request with the wrong protocol version, over the CLI's Content-Length framing.
  const server = (reply: string) => `
    const net = require('net');
    const s = net.createServer((c) => {
      let buf = Buffer.alloc(0);
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const end = buf.indexOf('\\r\\n\\r\\n');
          if (end < 0) return;
          const len = Number(/Content-Length: (\\d+)/i.exec(buf.slice(0, end).toString())[1]);
          if (buf.length < end + 4 + len) return;
          const msg = JSON.parse(buf.slice(end + 4, end + 4 + len).toString());
          buf = buf.slice(end + 4 + len);
          ${reply}
        }
      });
    });
    s.listen(0, '127.0.0.1', () => console.log('CLI server listening on port ' + s.address().port));
  `;

  it('reports a protocol mismatch', async () => {
    const probe = await driver.probe(fakeCli(dir(), server(`
      const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 99, version: '1.0.105', message: '', timestamp: 0 } });
      c.write('Content-Length: ' + Buffer.byteLength(out) + '\\r\\n\\r\\n' + out);
    `)));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'protocol_error' });
  }, 30_000);

  it('times out on a CLI that listens and never answers', async () => {
    const probe = await driver.probe(fakeCli(dir(), server('')));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
  }, 30_000);
});

  it('never picks autopilot when approving a plan', () => {
    expect(copilotPlanAction({ actions: ['autopilot', 'interactive', 'exit_only'], recommendedAction: 'autopilot' })).toBe('interactive');
    expect(copilotPlanAction({ actions: ['autopilot', 'exit_only'], recommendedAction: 'autopilot' })).toBe('exit_only');
    expect(copilotPlanAction({ actions: ['autopilot'], recommendedAction: 'autopilot' })).toBeUndefined();
  });


  it('passes an HTTP MCP server with its header from the environment', () => {
    const { servers, skipped } = toSdkMcpServers(
      { clubhouse: { command: 'node', args: ['bridge.js'] }, local: { command: 'tool', args: ['-x'], env: { A: 1 }, env_vars: ['FORWARD'] }, remote: { url: 'https://x', type: 'sse', headers: { H: 'v' } }, broken: {} },
      { NONCE: 'n', FORWARD: 'f' },
      { clubhouse: { url: 'http://127.0.0.1:9/mcp', headersFromEnv: { 'X-Clubhouse-Nonce': 'NONCE' } } },
    );
    expect(servers.clubhouse).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Clubhouse-Nonce': 'n' }, tools: ['*'] });
    expect(servers.local).toEqual({ type: 'stdio', command: 'tool', args: ['-x'], env: { A: '1', FORWARD: 'f' }, tools: ['*'] });
    expect(servers.remote).toEqual({ type: 'sse', url: 'https://x', headers: { H: 'v' }, tools: ['*'] });
    expect(skipped).toEqual(['broken']);
    // Without the header's value the bridge keeps its stdio command.
    expect(toSdkMcpServers({ b: { command: 'node' } }, {}, { b: { url: 'http://x', headersFromEnv: { H: 'MISSING' } } }).servers.b).toMatchObject({ type: 'stdio' });
  });

    it('reads only a whole message that starts with a command', () => {
      expect(parseSlashCommand('/compact')).toEqual({ name: 'compact' });
      expect(parseSlashCommand('  /review  look at x\ny ')).toEqual({ name: 'review', input: 'look at x\ny' });
      expect(parseSlashCommand('please /compact')).toBeUndefined();
      expect(parseSlashCommand('/tmp/file.txt is full')).toBeUndefined();
      expect(parseSlashCommand('/')).toBeUndefined();
    });
