/**
 * #2749: sessions a removed provider profile saved under its own
 * CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME are found there, read-only,
 * so Clubhouse never prunes them as missing. Fixture folders only; no CLI runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '' })),
  invalidateShellEnvironmentCache: vi.fn(),
  buildCliSpawnEnv: vi.fn((env?: Record<string, string>) => ({ ...env })),
}));

import { ClaudeCodeProvider } from './claude-code-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { CopilotCliProvider } from './copilot-cli-provider';

const ID = '01a14b15-91f5-7df0-837b-67c1c3ae69c3';
const OTHER = '01a14b16-0000-7000-8000-000000000003';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-profile-store-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(...segments: string[]): void {
  const file = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
}

describe('hasSessionInStore (#2749)', () => {
  it('Claude Code: finds <config>/projects/<cwd>/<id>.jsonl, and says false for a folder that is gone', async () => {
    write('claude-work', 'projects', '-work-app', `${ID}.jsonl`);
    const provider = new ClaudeCodeProvider();
    expect(await provider.hasSessionInStore(ID, path.join(root, 'claude-work'))).toBe(true);
    expect(await provider.hasSessionInStore(OTHER, path.join(root, 'claude-work'))).toBe(false);
    expect(await provider.hasSessionInStore(ID, path.join(root, 'nowhere'))).toBe(false);
  });

  it('Codex: finds the rollout under <CODEX_HOME>/sessions', async () => {
    write('codex-work', 'sessions', '2026', '10', '17', `rollout-2026-10-17T18-17-40-${ID}.jsonl`);
    const provider = new CodexCliProvider();
    expect(await provider.hasSessionInStore(ID, path.join(root, 'codex-work'))).toBe(true);
    expect(await provider.hasSessionInStore(OTHER, path.join(root, 'codex-work'))).toBe(false);
    expect(await provider.hasSessionInStore(ID, path.join(root, 'nowhere'))).toBe(false);
  });

  it('Copilot: finds the session folder under <COPILOT_HOME>/session-state', async () => {
    fs.mkdirSync(path.join(root, 'copilot-work', 'session-state', ID), { recursive: true });
    const provider = new CopilotCliProvider();
    expect(await provider.hasSessionInStore(ID, path.join(root, 'copilot-work'))).toBe(true);
    expect(await provider.hasSessionInStore(OTHER, path.join(root, 'copilot-work'))).toBe(false);
    expect(await provider.hasSessionInStore(ID, path.join(root, 'nowhere'))).toBe(false);
  });
});
