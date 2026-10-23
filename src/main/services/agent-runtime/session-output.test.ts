import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

vi.mock('./index', () => ({ getAgentRuntime: () => undefined }));

import { agentSessionOutputRoots, sessionOutputDir, verifySessionOutputDir } from './session-output';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-output-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sessionOutputDir', () => {
  it("is the Copilot session's own session-state folder, under COPILOT_HOME", () => {
    expect(sessionOutputDir('copilot-cli', 'abc-123', { COPILOT_HOME: '/opt/copilot' })).toBe(path.join('/opt/copilot', 'session-state', 'abc-123'));
    expect(sessionOutputDir('copilot-cli', 'abc', {})).toBe(path.join(os.homedir(), '.copilot', 'session-state', 'abc'));
  });

  it('is nothing for ids that are not plain tokens, or other providers', () => {
    for (const id of ['', '..', '../x', 'a/b', 'a\\b', '.', undefined]) expect(sessionOutputDir('copilot-cli', id, {})).toBeUndefined();
    expect(sessionOutputDir('claude-code', 'abc', {})).toBeUndefined();
    expect(sessionOutputDir('codex-cli', 'abc', {})).toBeUndefined();
  });
});

describe('verifySessionOutputDir', () => {
  it('accepts a real directory', async () => {
    const dir = path.join(tmpRoot, 'state', 's1');
    fs.mkdirSync(dir, { recursive: true });
    expect(await verifySessionOutputDir(dir)).toBe(fs.realpathSync.native(dir));
  });

  it('refuses missing folders, files, symlinks, relative paths, the root and the home folder or its parents', async () => {
    const file = path.join(tmpRoot, 'file');
    fs.writeFileSync(file, '');
    const link = path.join(tmpRoot, 'state', 'link');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(tmpRoot, link, 'dir');
    for (const dir of [path.join(tmpRoot, 'nope'), file, link, 'relative/dir', path.parse(tmpRoot).root, os.homedir(), path.dirname(os.homedir())]) {
      expect(await verifySessionOutputDir(dir)).toBeUndefined();
    }
  });
});

describe('agentSessionOutputRoots', () => {
  it('is empty without a live chat runtime', async () => {
    expect(await agentSessionOutputRoots('nobody')).toEqual([]);
  });
});
