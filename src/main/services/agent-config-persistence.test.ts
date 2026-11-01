import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// In-memory filesystem so tests can interleave mutations with in-flight writes.
const files = new Map<string, string>();
/** When set, the next agents.json temp-file write blocks until released. */
let writeGate: { reached: () => void; release: Promise<void> } | null = null;
/** Errors to throw from readFile for specific paths (simulates EACCES/EBUSY). */
const readErrors = new Map<string, NodeJS.ErrnoException>();
/** Directory identities for stat(); paths not listed fall back to path identity. */
const dirInodes = new Map<string, number | bigint>();
const copiedFiles: Array<[string, string]> = [];

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (...args: unknown[]) => void) => { cb(null, ''); return {}; }),
  execFile: vi.fn((_f: string, _a: string[], _opts: unknown, cb: (...args: unknown[]) => void) => { cb(null, ''); return {}; }),
}));

vi.mock('fs', () => ({
  watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() })),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const err = readErrors.get(String(p));
    if (err) throw err;
    const data = files.get(String(p));
    if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return data;
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    if (writeGate && String(p).includes('agents.json.tmp.')) {
      const gate = writeGate;
      writeGate = null;
      gate.reached();
      await gate.release;
    }
    files.set(String(p), String(data));
  }),
  rename: vi.fn(async (src: string, dest: string) => {
    const data = files.get(String(src));
    if (data !== undefined) files.set(String(dest), data);
    files.delete(String(src));
  }),
  // Like Node: a plain stat rounds a file ID to a Number, a bigint stat keeps it exact.
  stat: vi.fn(async (p: string, opts?: { bigint?: boolean }) => {
    const ino = dirInodes.get(String(p));
    if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return opts?.bigint ? { dev: BigInt(1), ino: BigInt(ino) } : { dev: 1, ino: Number(ino) };
  }),
  copyFile: vi.fn(async (src: string, dest: string) => { copiedFiles.push([String(src), String(dest)]); }),
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(async (p: string) => files.has(String(p))),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(async () => false) }));
vi.mock('./agent-settings-service', () => ({
  applyAgentDefaults: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));

import {
  clearAgentConfigCache,
  createDurable,
  deleteUnregister,
  flushAgentConfig,
  flushAllAgentConfigs,
  isSameProject,
  listDurable,
  projectKey,
  renameDurable,
  restoreFromBackup,
} from './agent-config';

const PROJECT_PATH = path.resolve('test-project');
const CONFIG_PATH = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
const BACKUP_PATH = path.join(PROJECT_PATH, '.clubhouse', 'agents.json.bak');

const AGENT_A = { id: 'durable_1_a', name: 'alpha', color: 'blue' };
const AGENT_B = { id: 'durable_2_b', name: 'bravo', color: 'red' };

function diskIds(filePath = CONFIG_PATH): string[] {
  return (JSON.parse(files.get(filePath) ?? '[]') as Array<{ id: string }>).map((a) => a.id);
}

/** Block the next agents.json write; resolves once the write is in flight. */
function gateNextWrite(): { inFlight: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const inFlight = new Promise<void>((resolve) => { reached = resolve; });
  writeGate = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
  return { inFlight, release };
}

beforeEach(() => {
  clearAgentConfigCache();
  files.clear();
  readErrors.clear();
  dirInodes.clear();
  copiedFiles.length = 0;
  writeGate = null;
});

describe('agent-config persistence barrier', () => {
  it('persists a mutation made while an earlier write is in flight', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    await listDurable(PROJECT_PATH);

    await createDurable(PROJECT_PATH, 'second', 'green', undefined, false);
    const gate = gateNextWrite();
    const firstFlush = flushAgentConfig(PROJECT_PATH);
    await gate.inFlight;

    // Third agent is created while the two-agent write is still pending.
    const third = await createDurable(PROJECT_PATH, 'third', 'yellow', undefined, false);
    gate.release();
    await firstFlush;
    await flushAllAgentConfigs();

    expect(diskIds()).toHaveLength(3);
    expect(diskIds()).toContain(third.id);

    // Reload from disk — the third agent must survive.
    clearAgentConfigCache();
    const reloaded = await listDurable(PROJECT_PATH);
    expect(reloaded.map((a) => a.id)).toContain(third.id);
  });

  it('flushAllAgentConfigs drains an in-place edit that landed mid-write', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A, AGENT_B]));
    await listDurable(PROJECT_PATH);

    await renameDurable(PROJECT_PATH, AGENT_A.id, 'alpha-1');
    const gate = gateNextWrite();
    const shutdown = flushAllAgentConfigs();
    await gate.inFlight;
    await renameDurable(PROJECT_PATH, AGENT_B.id, 'bravo-1');
    gate.release();
    await shutdown;

    const onDisk = JSON.parse(files.get(CONFIG_PATH)!) as Array<{ id: string; name: string }>;
    expect(onDisk.map((a) => a.name)).toEqual(['alpha-1', 'bravo-1']);
  });

  it('keeps a mid-write mutation alongside a merged external edit', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    await listDurable(PROJECT_PATH);

    // External process adds an agent before our flush reads the file.
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A, AGENT_B]));
    await renameDurable(PROJECT_PATH, AGENT_A.id, 'alpha-1');
    const gate = gateNextWrite();
    const flush = flushAgentConfig(PROJECT_PATH);
    await gate.inFlight;
    const third = await createDurable(PROJECT_PATH, 'third', 'yellow', undefined, false);
    gate.release();
    await flush;

    const onDisk = JSON.parse(files.get(CONFIG_PATH)!) as Array<{ id: string; name: string }>;
    expect(onDisk.map((a) => a.id).sort()).toEqual([AGENT_A.id, AGENT_B.id, third.id].sort());
    expect(onDisk.find((a) => a.id === AGENT_A.id)?.name).toBe('alpha-1');
  });
});

describe('agent-config read errors', () => {
  it('does not cache an empty list when agents.json is transiently unreadable', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A, AGENT_B]));
    files.set(BACKUP_PATH, JSON.stringify([AGENT_A]));
    readErrors.set(CONFIG_PATH, Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));

    await expect(listDurable(PROJECT_PATH)).rejects.toThrow('EBUSY');
    // Neither file was rewritten from the (older) backup.
    expect(diskIds()).toEqual([AGENT_A.id, AGENT_B.id]);
    expect(diskIds(BACKUP_PATH)).toEqual([AGENT_A.id]);

    readErrors.clear();
    const agents = await listDurable(PROJECT_PATH);
    expect(agents.map((a) => a.id)).toEqual([AGENT_A.id, AGENT_B.id]);
  });

  it('does not treat a transient backup read error as an empty state', async () => {
    files.set(CONFIG_PATH, '{{corrupt');
    files.set(BACKUP_PATH, JSON.stringify([AGENT_A]));
    readErrors.set(BACKUP_PATH, Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));

    await expect(listDurable(PROJECT_PATH)).rejects.toThrow('EMFILE');

    readErrors.clear();
    const agents = await listDurable(PROJECT_PATH);
    expect(agents.map((a) => a.id)).toEqual([AGENT_A.id]);
  });
});

describe('agent-config invalid records', () => {
  it('falls back to a healthy backup when agents.json holds only invalid records', async () => {
    const backup = JSON.stringify([AGENT_A, AGENT_B]);
    files.set(CONFIG_PATH, JSON.stringify([null]));
    files.set(BACKUP_PATH, backup);

    const agents = await listDurable(PROJECT_PATH);
    expect(agents.map((a) => a.id)).toEqual([AGENT_A.id, AGENT_B.id]);
    expect(diskIds()).toEqual([AGENT_A.id, AGENT_B.id]);
    expect(files.get(BACKUP_PATH)).toBe(backup);
  });

  it('drops invalid records without overwriting the backup', async () => {
    const backup = JSON.stringify([AGENT_A, AGENT_B]);
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A, null, 42, { name: 'no-id' }]));
    files.set(BACKUP_PATH, backup);

    const agents = await listDurable(PROJECT_PATH);
    expect(agents.map((a) => a.id)).toEqual([AGENT_A.id]);
    expect(diskIds()).toEqual([AGENT_A.id]);
    expect(files.get(BACKUP_PATH)).toBe(backup);
  });

  it('keeps an intentionally empty agents.json empty', async () => {
    files.set(CONFIG_PATH, '[]');
    files.set(BACKUP_PATH, JSON.stringify([AGENT_A]));

    expect(await listDurable(PROJECT_PATH)).toEqual([]);
    expect(files.get(CONFIG_PATH)).toBe('[]');
  });
});

describe('agent-config cross-project durable ID collisions', () => {
  const OTHER_PATH = path.resolve('copied-project');
  const OTHER_CONFIG = path.join(OTHER_PATH, '.clubhouse', 'agents.json');
  const OTHER_BACKUP = path.join(OTHER_PATH, '.clubhouse', 'agents.json.bak');

  it('reassigns an ID already loaded by another project and persists it', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    files.set(OTHER_CONFIG, JSON.stringify([AGENT_A, AGENT_B]));

    const first = await listDurable(PROJECT_PATH);
    const second = await listDurable(OTHER_PATH);

    expect(first.map((a) => a.id)).toEqual([AGENT_A.id]);
    const copy = second[0];
    expect(copy.id).not.toBe(AGENT_A.id);
    expect(copy.id).toMatch(/^durable_\d+_[a-z0-9]+$/);
    expect(copy).toMatchObject({ name: AGENT_A.name, color: AGENT_A.color });
    expect(second[1].id).toBe(AGENT_B.id);

    await flushAllAgentConfigs();
    expect(diskIds(OTHER_CONFIG)).toEqual([copy.id, AGENT_B.id]);
    expect(diskIds()).toEqual([AGENT_A.id]);
  });

  it('keeps the reassignment stable across cache reloads', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    files.set(OTHER_CONFIG, JSON.stringify([AGENT_A]));

    await listDurable(PROJECT_PATH);
    const copyId = (await listDurable(OTHER_PATH))[0].id;
    await flushAllAgentConfigs();

    // The agents.json watcher clears a cache entry after every write.
    clearAgentConfigCache(PROJECT_PATH);
    clearAgentConfigCache(OTHER_PATH);
    expect((await listDurable(OTHER_PATH)).map((a) => a.id)).toEqual([copyId]);
    expect((await listDurable(PROJECT_PATH)).map((a) => a.id)).toEqual([AGENT_A.id]);
    await flushAllAgentConfigs();
    expect(diskIds()).toEqual([AGENT_A.id]);
    expect(diskIds(OTHER_CONFIG)).toEqual([copyId]);
  });

  it('does not reassign when the same directory is reached through another path', async () => {
    const alias = path.resolve('alias-of-test-project');
    dirInodes.set(PROJECT_PATH, 42);
    dirInodes.set(alias, 42);
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    files.set(path.join(alias, '.clubhouse', 'agents.json'), JSON.stringify([AGENT_A]));

    await listDurable(PROJECT_PATH);
    expect((await listDurable(alias)).map((a) => a.id)).toEqual([AGENT_A.id]);
  });

  describe('file IDs above 2^53 (#2628)', () => {
    // NTFS: a 16-bit sequence number over a 48-bit record number, so a reused
    // record's ID passes 2^53 and neighboring folders differ only in low bits.
    const FILE_ID = (BigInt(40) << BigInt(48)) | BigInt(1000);
    const NEIGHBOR_ID = FILE_ID + BigInt(1);

    it('uses IDs a Number cannot tell apart', () => {
      expect(Number(FILE_ID)).toBe(Number(NEIGHBOR_ID));
    });

    it('keeps neighboring folders apart as projects', async () => {
      dirInodes.set(PROJECT_PATH, FILE_ID);
      dirInodes.set(OTHER_PATH, NEIGHBOR_ID);
      expect(await isSameProject(PROJECT_PATH, OTHER_PATH)).toBe(false);
      expect(await projectKey(PROJECT_PATH)).toBe(`ino:1:${FILE_ID}`);
      expect(await projectKey(OTHER_PATH)).toBe(`ino:1:${NEIGHBOR_ID}`);
    });

    it('still reassigns an ID copied into a neighboring folder', async () => {
      dirInodes.set(PROJECT_PATH, FILE_ID);
      dirInodes.set(OTHER_PATH, NEIGHBOR_ID);
      files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
      files.set(OTHER_CONFIG, JSON.stringify([AGENT_A]));

      await listDurable(PROJECT_PATH);
      expect((await listDurable(OTHER_PATH))[0].id).not.toBe(AGENT_A.id);
    });

    it('still sees one folder reached through two paths as one project', async () => {
      const alias = path.resolve('alias-of-test-project');
      dirInodes.set(PROJECT_PATH, FILE_ID);
      dirInodes.set(alias, FILE_ID);
      expect(await isSameProject(PROJECT_PATH, alias)).toBe(true);
    });
  });

  it('falls back to the path when a folder has no file ID or cannot be read (#2628)', async () => {
    dirInodes.set(PROJECT_PATH, BigInt(0));
    expect(await projectKey(PROJECT_PATH)).toMatch(/^path:/);
    expect(await projectKey(OTHER_PATH)).toMatch(/^path:/);
    expect(await isSameProject(PROJECT_PATH, OTHER_PATH)).toBe(false);
  });

  it('releases ownership when the owning project removes the agent', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    files.set(OTHER_CONFIG, JSON.stringify([AGENT_A]));

    await listDurable(PROJECT_PATH);
    await deleteUnregister(PROJECT_PATH, AGENT_A.id);
    expect((await listDurable(OTHER_PATH)).map((a) => a.id)).toEqual([AGENT_A.id]);
  });

  it('gives the reassigned agent its own icon file', async () => {
    const withIcon = { ...AGENT_A, icon: `${AGENT_A.id}.png` };
    files.set(CONFIG_PATH, JSON.stringify([withIcon]));
    files.set(OTHER_CONFIG, JSON.stringify([withIcon]));

    await listDurable(PROJECT_PATH);
    const copy = (await listDurable(OTHER_PATH))[0];
    expect(copy.icon).toBe(`${copy.id}.png`);
    expect(copiedFiles.map(([src, dest]) => [path.basename(src), path.basename(dest)]))
      .toEqual([[`${AGENT_A.id}.png`, `${copy.id}.png`]]);
  });

  it('reassigns foreign IDs restored from a backup', async () => {
    files.set(CONFIG_PATH, JSON.stringify([AGENT_A]));
    files.set(OTHER_CONFIG, JSON.stringify([AGENT_B]));
    files.set(OTHER_BACKUP, JSON.stringify([AGENT_A, AGENT_B]));

    await listDurable(PROJECT_PATH);
    const result = await restoreFromBackup(OTHER_PATH);
    expect(result.restoredCount).toBe(1);
    const restoredIds = result.agents.map((a) => a.id);
    expect(restoredIds[0]).toBe(AGENT_B.id);
    expect(restoredIds[1]).not.toBe(AGENT_A.id);
    expect(diskIds(OTHER_CONFIG)).toEqual(restoredIds);
  });
});
