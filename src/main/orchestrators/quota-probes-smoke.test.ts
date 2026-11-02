/**
 * Plan limits against REAL installed CLIs with no login: a temp home and a made-up
 * key, and a base URL that goes nowhere paid. Pins what each CLI says when there is
 * no plan to read, and that asking sends nothing to a model.
 *
 * Skipped unless CLUBHOUSE_FAKE_MODEL_SMOKE=1.
 *   CLUBHOUSE_FAKE_MODEL_BIN_DIR    folder holding the CLI binaries under test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeModelServer, type FakeModelServer } from '../chat/testing/fake-model-server';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), `clubhouse-fake-model-${name}`), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));
// The login shell's env holds the user's real keys; the CLI gets none of it.
vi.mock('../util/shell', async (importOriginal) => ({
  ...await importOriginal<typeof import('../util/shell')>(),
  getShellEnvironment: () => ({ PATH: process.env.PATH ?? '', USER: 'fake', SHELL: '/bin/sh' }),
}));

import { probeClaudeQuota, probeCodexQuota } from './quota-probes';

const enabled = process.env.CLUBHOUSE_FAKE_MODEL_SMOKE === '1';

describe.skipIf(!enabled)('Plan limits (real CLI, no login)', () => {
  let model: FakeModelServer;
  let root: string;
  beforeAll(async () => {
    model = await startFakeModelServer();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quota-smoke-')));
  });
  afterAll(async () => {
    await model?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const context = (bin: string, env: Record<string, string>) => ({
    binary: path.join(process.env.CLUBHOUSE_FAKE_MODEL_BIN_DIR ?? '', bin),
    cwd: fs.mkdtempSync(path.join(root, 'cwd-')),
    env: { PATH: process.env.PATH ?? '', USER: 'fake', ...env },
    signal: new AbortController().signal,
    timeoutMs: 20_000,
  });

  it('Claude Code with an API key has no plan to read, and no request reaches a model', async () => {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    const before = model.requests.length;
    const reading = await probeClaudeQuota(context('claude', {
      HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'fake-key-for-a-local-server',
    }));
    expect(reading).toEqual({ kind: 'not_applicable' });
    expect(model.requests.length).toBe(before);
  }, 60_000);

  it('Codex with an API key has no plan to read, and no request reaches a model', async () => {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    const before = model.requests.length;
    const reading = await probeCodexQuota(context('codex', { HOME: home, CODEX_HOME: home, OPENAI_API_KEY: 'fake-key-for-a-local-server', CODEX_API_KEY: '' }));
    expect(reading).toEqual({ kind: 'not_applicable' });
    expect(model.requests.length).toBe(before);
  }, 60_000);
});
