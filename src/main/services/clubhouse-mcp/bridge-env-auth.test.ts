/**
 * The bridge script authenticates with the nonce from its own environment,
 * inherited from the agent CLI, never from the MCP config (#2222). These
 * spawn the real bridge the way each CLI starts a stdio server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/clubhouse-test' } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { buildClubhouseMcpDef, CLUBHOUSE_NONCE_ENV } from './injection';

const NONCE = 'f3a9c2d1-7b4e-4c6a-9d8f-1e2b3c4d5e6f';

interface Seen { method?: string; url?: string; nonce?: string }

let server: http.Server;
let port: number;
let seen: Seen[];

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    const nonce = req.headers['x-clubhouse-nonce'] as string | undefined;
    seen.push({ method: req.method, url: req.url, nonce });
    if (nonce !== NONCE) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET') {
      // SSE stream: keep it open.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Start the bridge with `env`, send one request, and return its reply line (or exit code). */
function runBridge(env: Record<string, string>): Promise<{ reply?: { result?: unknown; error?: unknown }; exitCode?: number | null; stderr: string }> {
  const def = buildClubhouseMcpDef(port, 'agent-1');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, def.args!, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`bridge timed out: ${stderr}`)); }, 10_000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        child.kill();
        resolve({ reply: JSON.parse(out.slice(0, nl)), stderr });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
}

/** A minimal env any child needs (Windows: node wants SystemRoot). */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** What the CLI's own environment holds: the spawn env Clubhouse gave it. */
function cliEnv(): Record<string, string> {
  return { ...baseEnv(), [CLUBHOUSE_NONCE_ENV]: NONCE };
}

describe('Clubhouse MCP bridge auth via env (#2222)', () => {
  it('authenticates when the CLI passes its whole env (Claude Code, Copilot CLI)', async () => {
    const def = buildClubhouseMcpDef(port, 'agent-1');
    const result = await runBridge({ ...cliEnv(), ...def.env });
    expect(result.reply).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const post = seen.find((s) => s.method === 'POST');
    expect(post).toMatchObject({ url: '/mcp/agent-1', nonce: NONCE });
  });

  it('authenticates when the CLI forwards only env_vars (Codex)', async () => {
    const def = buildClubhouseMcpDef(port, 'agent-1');
    const parent = cliEnv();
    // Codex: a minimal base env, the server's `env`, and the names in `env_vars`.
    const forwarded = Object.fromEntries((def.env_vars ?? []).map((k) => [k, parent[k]]));
    const result = await runBridge({ ...baseEnv(), ...def.env, ...forwarded });
    expect(result.reply).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(seen.find((s) => s.method === 'POST')?.nonce).toBe(NONCE);
  });

  it('the config alone carries no usable nonce: the bridge refuses to start', async () => {
    const def = buildClubhouseMcpDef(port, 'agent-1');
    const result = await runBridge({ ...baseEnv(), ...def.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing required env vars');
    expect(seen).toEqual([]);
  });

  it('treats an unexpanded ${CLUBHOUSE_HOOK_NONCE} placeholder as no nonce', async () => {
    const def = buildClubhouseMcpDef(port, 'agent-1');
    const result = await runBridge({ ...baseEnv(), ...def.env, [CLUBHOUSE_NONCE_ENV]: '${CLUBHOUSE_HOOK_NONCE}' });
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual([]);
  });
});
