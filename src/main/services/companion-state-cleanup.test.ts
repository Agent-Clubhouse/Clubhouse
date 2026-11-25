import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const logs = vi.hoisted(() => [] as Array<{ level: string; msg: string; meta?: unknown }>);
vi.mock('./log-service', () => ({
  appLog: (_ns: string, level: string, msg: string, opts?: { meta?: unknown }) => { logs.push({ level, msg, meta: opts?.meta }); },
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { companionWorkspacesDir, removeCompanionState } from './companion-state-cleanup';

describe('removeCompanionState', () => {
  let home: string;

  beforeEach(async () => {
    logs.length = 0;
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'companion-state-'));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('removes every companion workspace and logs which ones, leaving the rest of the Clubhouse folder', async () => {
    const dir = companionWorkspacesDir(home);
    fs.mkdirSync(path.join(dir, 'my-plugin', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'my-plugin', 'notes.md'), 'x');
    fs.mkdirSync(path.join(home, '.clubhouse', 'plugin-data', 'my-plugin'), { recursive: true });

    expect(await removeCompanionState(home)).toBe(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.clubhouse', 'plugin-data', 'my-plugin'))).toBe(true);
    expect(logs).toEqual([expect.objectContaining({ level: 'info', meta: { dir, workspaces: ['my-plugin'] } })]);
  });

  it('does nothing and logs nothing when there are no companion workspaces', async () => {
    expect(await removeCompanionState(home)).toBeNull();
    expect(logs).toEqual([]);
  });
});
