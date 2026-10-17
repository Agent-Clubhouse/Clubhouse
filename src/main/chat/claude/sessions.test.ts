import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listClaudeSessions, readClaudeSession } from './sdk-transport';

/** Claude Code's project dir name: every non-alphanumeric character becomes '-'. */
const encodeProjectDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

describe('Claude session helpers (Agent SDK, on-disk JSONL)', () => {
  let configDir: string;
  let cwd: string;
  let previous: string | undefined;
  const sessionId = '0b5c6a2e-1f3d-4c8e-9a7b-2d4e6f8a0c1e';

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-claude-config-'));
    // Canonical (8.3 names expanded on Windows) so the encoded dir matches what the SDK derives.
    cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-claude-cwd-')));
    previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectDir = path.join(configDir, 'projects', encodeProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd, timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'user', content: 'fix the build' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd, timestamp: '2026-10-16T10:00:01.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'On it' }] } },
    ];
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('lists sessions for a project directory', async () => {
    const sessions = await listClaudeSessions(cwd);
    expect(sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    expect(sessions[0].firstPrompt).toBe('fix the build');
  });

  it('reads a session transcript', async () => {
    const messages = await readClaudeSession(sessionId, cwd);
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant']);
  });
});
