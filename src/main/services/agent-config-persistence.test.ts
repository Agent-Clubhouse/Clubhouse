import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// In-memory filesystem so tests can interleave mutations with in-flight writes.
const files = new Map<string, string>();
/** When set, the next agents.json temp-file write blocks until released. */
let writeGate: { reached: () => void; release: Promise<void> } | null = null;
/** Errors to throw from readFile for specific paths (simulates EACCES/EBUSY). */
const readErrors = new Map<string, NodeJS.ErrnoException>();

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
  flushAgentConfig,
  flushAllAgentConfigs,
  listDurable,
  renameDurable,
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
